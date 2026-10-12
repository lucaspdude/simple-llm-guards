#!/usr/bin/env node
// The one process every subprocess-based harness talks to.
//
//   echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' \
//     | node guard-hook.js --harness claude
//
// It reads the harness payload on stdin, evaluates it against the shared rule
// set, and prints whatever that harness expects on stdout. Same binary, five
// harnesses; only the adapter changes.

import process from 'node:process';
import { evaluate } from './engine.js';
import { defaultConfigPath, loadConfig } from './rules.js';
import * as claude from './adapters/claude.js';
import * as copilot from './adapters/copilot.js';
import * as gemini from './adapters/gemini.js';
import * as agy from './adapters/agy.js';

const ADAPTERS = { claude, copilot, gemini, agy };

export function run(payload, harness, configFile = defaultConfigPath()) {
  const adapter = ADAPTERS[harness];
  if (!adapter) throw new Error(`unknown harness "${harness}" (expected one of ${Object.keys(ADAPTERS).join(', ')})`);
  const config = loadConfig(configFile);
  const decision = evaluate({ harness, ...adapter.parse(payload) }, config);
  return { decision, response: adapter.format(decision) };
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`stdin is not valid JSON — ${e.message}`); }
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const harness = argValue('--harness') ?? process.env.GUARDS_HARNESS;
  if (!harness) {
    process.stderr.write('usage: guard-hook.js --harness <claude|copilot|gemini|agy>\n');
    process.exit(64);
  }
  let payload;
  try {
    payload = await readStdin();
  } catch (e) {
    // Unparseable payload: we cannot judge the call, so block it. Every one of
    // these harnesses treats a non-zero exit as a denial.
    process.stderr.write(`guards: ${e.message}\n`);
    process.exit(2);
    return;
  }

  let result;
  try {
    result = run(payload, harness);
  } catch (e) {
    let failOpen = false;
    try { failOpen = loadConfig().failOpen === true; } catch { /* config itself is broken */ }
    process.stderr.write(`guards: ${e.message}\n`);
    process.exit(failOpen ? 0 : 2);
    return;
  }

  if (process.env.GUARDS_LOG) {
    process.stderr.write(`guards[${harness}] ${result.decision.action} ${result.decision.ruleId ?? '-'} ${result.decision.tool}\n`);
  }
  if (result.response.stdout) process.stdout.write(result.response.stdout + '\n');
  process.exit(result.response.exitCode ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}