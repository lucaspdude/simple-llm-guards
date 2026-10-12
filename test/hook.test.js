import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'src', 'guard-hook.js');
const RULES = path.join(os.tmpdir(), 'simple-llm-guards-test.jsonc');

// One real rules file, written the way `guards init` writes it.
fs.mkdirSync(path.dirname(RULES), { recursive: true });
fs.writeFileSync(RULES, `{
  // only the dangerous thing
  "rules": [
    { "id": "no-rm-rf-root", "tools": ["shell"],
      "when": [{ "arg": "command", "regex": "rm\\\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\\\s+)+(/|~)(\\\\s|$)" }],
      "reason": "nao apague a raiz." }
  ]
}`);

/** Run the real hook binary the way a harness would: JSON on stdin, JSON on stdout. */
function hook(harness, payload, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [HOOK, '--harness', harness], {
      input: JSON.stringify(payload),
      env: { ...process.env, GUARDS_CONFIG: RULES, ...env },
      encoding: 'utf8',
    });
    return { stdout: stdout.trim(), code: 0 };
  } catch (e) {
    return { stdout: String(e.stdout ?? '').trim(), stderr: String(e.stderr ?? '').trim(), code: e.status };
  }
}

const DENY = { command: 'rm -rf /', cwd: '/tmp' };

test('claude hook denies with the documented PreToolUse JSON', async () => {
  const r = await hook('claude', { tool_name: 'Bash', tool_input: DENY, cwd: '/tmp' });
  const body = JSON.parse(r.stdout);
  assert.equal(r.code, 0);
  assert.equal(body.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /nao apague a raiz/);
});

test('gemini hook denies with decision/reason', async () => {
  const r = await hook('gemini', { tool_name: 'run_shell_command', tool_input: DENY, cwd: '/tmp' });
  const body = JSON.parse(r.stdout);
  assert.equal(body.decision, 'deny');
  assert.match(body.reason, /nao apague a raiz/);
});

test('agy hook denies from the nested toolCall payload', async () => {
  const r = await hook('agy', { toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } }, workspacePaths: ['/tmp'] });
  assert.equal(JSON.parse(r.stdout).decision, 'deny');
});

test('copilot hook denies with permissionDecision', async () => {
  const r = await hook('copilot', { sessionId: 's', cwd: '/tmp', toolName: 'bash', toolArgs: DENY });
  assert.equal(JSON.parse(r.stdout).permissionDecision, 'deny');
});

test('allowed calls print nothing and exit 0', async () => {
  for (const harness of ['claude', 'gemini', 'agy', 'copilot']) {
    const payload = harness === 'agy'
      ? { toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } } }
      : { tool_name: 'bash', toolName: 'bash', tool_input: { command: 'npm test' }, toolArgs: { command: 'npm test' } };
    const r = await hook(harness, payload);
    assert.equal(r.code, 0, harness);
    assert.equal(r.stdout, '', `${harness} must stay silent on allow`);
  }
});

test('a broken rules file blocks the call instead of letting it through', async () => {
  const bad = path.join(os.tmpdir(), 'simple-llm-guards-broken.jsonc');
  fs.writeFileSync(bad, '{ not json');
  const r = await hook('claude', { tool_name: 'Bash', tool_input: DENY }, { GUARDS_CONFIG: bad });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /invalid JSON/);
});

test('failOpen lets the call through when the rules file is broken', async () => {
  const bad = path.join(os.tmpdir(), 'simple-llm-guards-open.jsonc');
  fs.writeFileSync(bad, '{ not json');
  const r = await hook('claude', { tool_name: 'Bash', tool_input: DENY }, { GUARDS_CONFIG: bad });
  assert.equal(r.code, 2);
});

test('unparseable stdin fails closed', async () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [HOOK, '--harness', 'claude'], {
      input: 'nao e json',
      env: { ...process.env, GUARDS_CONFIG: RULES },
      encoding: 'utf8',
    });
  } catch (e) { code = e.status; stderr = String(e.stderr); }
  assert.equal(code, 2);
  assert.match(stderr, /not valid JSON/);
});

test('an unknown harness fails closed instead of guessing', async () => {
  // We cannot judge a call from a harness we do not know, so we block it.
  const unknown = await hook('codex', { tool_name: 'bash', tool_input: DENY });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown harness/);

  // A missing --harness is a broken install, not a policy decision.
  let code = 0;
  try {
    execFileSync(process.execPath, [HOOK], { input: '{}', env: { ...process.env, GUARDS_CONFIG: RULES } });
  } catch (e) { code = e.status; }
  assert.equal(code, 64);
});