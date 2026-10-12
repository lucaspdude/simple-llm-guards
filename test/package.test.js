import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * The whole point of the package, tested end to end:
 *
 *   npm pack -> untar somewhere with no .git -> run it like npx would
 *   -> the runtime must land in a durable place, not in the temp dir
 *   -> the generated hook must point at that durable place
 *   -> and the copied runtime must actually block a tool call.
 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-pack-'));
const PACKED = path.join(TMP, 'node_modules', 'simple-llm-guards');
const HOME = path.join(TMP, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

execFileSync('npm', ['pack', '--silent', '--pack-destination', TMP], { cwd: ROOT, encoding: 'utf8' });
const tarball = fs.readdirSync(TMP).find((f) => f.endsWith('.tgz'));
fs.mkdirSync(PACKED, { recursive: true });
execFileSync('tar', ['-xzf', path.join(TMP, tarball), '-C', PACKED, '--strip-components=1']);
const CLI = path.join(PACKED, 'src', 'cli.js');

function run(args, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME, GUARDS_CONFIG: path.join(HOME, 'rules.jsonc'), ...extraEnv },
  });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// GUARDS_CONFIG is <HOME>/rules.jsonc, so the runtime sits beside it.
const runtimeHome = path.join(HOME, 'runtime');

test('the published tarball carries the runtime and nothing private', () => {
  assert.ok(fs.existsSync(path.join(PACKED, 'src', 'guard-hook.js')));
  assert.ok(fs.existsSync(path.join(PACKED, 'src', 'adapters', 'agy.js')));
  assert.ok(fs.existsSync(path.join(PACKED, 'LICENSE')));
  assert.ok(!fs.existsSync(path.join(PACKED, 'test')), 'tests do not ship');
  assert.ok(!fs.existsSync(path.join(PACKED, 'scripts')), 'release tooling does not ship');
  assert.ok(!fs.existsSync(path.join(PACKED, '.git')), 'no git metadata');
  assert.equal(readJson(path.join(PACKED, 'package.json')).private, undefined, 'must be publishable');
});

test('installing from an unpacked tarball copies the runtime out of the temp dir', () => {
  run(['init']);
  run(['install', 'claude']);

  assert.ok(
    fs.existsSync(path.join(runtimeHome, 'src', 'guard-hook.js')),
    'the runtime must be copied to a durable path, not left in the temp dir',
  );
  assert.equal(fs.readFileSync(path.join(runtimeHome, 'VERSION'), 'utf8').trim(),
    readJson(path.join(PACKED, 'package.json')).version);
});

test('the generated hook points at the durable runtime, not the unpacked tarball', () => {
  const settings = readJson(path.join(HOME, '.claude', 'settings.json'));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;

  assert.ok(command.includes(path.join(runtimeHome, 'src', 'guard-hook.js')), command);
  assert.ok(!command.includes(PACKED), 'must not point back into the unpacked package: ' + command);
  assert.match(command, /--harness claude$/);
});

test('the copied runtime really blocks a call', () => {
  const out = execFileSync(process.execPath, [path.join(runtimeHome, 'src', 'guard-hook.js'), '--harness', 'claude'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: TMP }),
    encoding: 'utf8',
    env: { ...process.env, HOME, GUARDS_CONFIG: path.join(HOME, 'rules.jsonc') },
  });
  const body = JSON.parse(out);
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(body.hookSpecificOutput.permissionDecisionReason, /no-rm-rf-root/);
});

test('status reports the version and does not call a fresh install stale', () => {
  const out = run(['status']);
  const version = readJson(path.join(PACKED, 'package.json')).version;
  assert.match(out, new RegExp(`version: ${version.replace(/\./g, '\\.')}`));
  assert.ok(!out.includes('desatualizada'), out);
});

test('bare invocation with no arguments installs instead of printing help', () => {
  const home2 = path.join(TMP, 'home-bare');
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
  const out = execFileSync(process.execPath, [CLI], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home2, GUARDS_CONFIG: path.join(home2, 'rules.jsonc') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // No terminal: it takes the detected path instead of opening the picker.
  assert.match(out, /harness detectadas|✓ claude/);
});

test('packaged cleanup', { skip: false }, () => fs.rmSync(TMP, { recursive: true, force: true }));