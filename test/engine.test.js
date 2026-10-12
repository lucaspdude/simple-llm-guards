import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, globToRegExp } from '../src/engine.js';
import { parseConfig, stripJsonComments } from '../src/rules.js';
import { canonicalTool, normalize } from '../src/normalize.js';
import { STARTER_RULES } from '../src/starter.js';

const config = parseConfig(STARTER_RULES, 'starter');
const rmRf = { harness: 'claude', tool: 'Bash', args: { command: 'rm -rf /' }, cwd: '/tmp' };

test('starter rules load and validate', () => {
  assert.equal(config.rules.length, 5);
  for (const rule of config.rules) assert.ok(rule.id && rule.reason);
});

test('JSONC comments are stripped, // inside strings is kept', () => {
  assert.equal(stripJsonComments('{"a": 1} // x').trim(), '{"a": 1}');
  assert.match(stripJsonComments('{"a": "http://x"}'), /http:\/\/x/);
  assert.match(stripJsonComments('{/* c */ "a": 1}'), /"a": 1/);
});

test('globToRegExp handles ** and *', () => {
  assert.ok(globToRegExp('**/.env').test('/repo/app/.env'));
  assert.ok(globToRegExp('**/.env').test('.env'));
  assert.ok(!globToRegExp('*.env').test('/repo/.env'));
  assert.ok(globToRegExp('**/.ssh/**').test('/home/u/.ssh/id_rsa'));
});

test('every harness normalizes to the same canonical tool', () => {
  for (const [harness, native] of Object.entries({
    pi: 'bash', omp: 'bash', claude: 'Bash', copilot: 'bash',
    gemini: 'run_shell_command', agy: 'run_command',
  })) {
    assert.equal(canonicalTool(harness, native), 'shell', harness);
  }
  for (const [harness, native] of Object.entries({
    pi: 'write', omp: 'write', claude: 'Write', copilot: 'create',
    gemini: 'write_file', agy: 'write_to_file',
  })) {
    assert.equal(canonicalTool(harness, native), 'write', harness);
  }
});

test('one rule blocks the same command in every harness', () => {
  const payloads = {
    pi: { tool: 'bash', args: { command: 'rm -rf /' } },
    omp: { tool: 'bash', args: { command: 'rm -rf /' } },
    claude: { tool: 'Bash', args: { command: 'rm -rf /' } },
    copilot: { tool: 'bash', args: { command: 'rm -rf /' } },
    gemini: { tool: 'run_shell_command', args: { command: 'rm -rf /' } },
    agy: { tool: 'run_command', args: { args: { CommandLine: 'rm -rf /' } } },
  };
  for (const [harness, p] of Object.entries(payloads)) {
    const args = p.args.args ?? p.args;
    const decision = evaluate({ harness, ...p, args, cwd: '/tmp' }, config);
    assert.equal(decision.action, 'deny', harness);
    assert.equal(decision.ruleId, 'no-rm-rf-root', harness);
  }
});

test('secret reads are blocked through three different path argument names', () => {
  const decision = evaluate(
    { harness: 'gemini', tool: 'read_file', args: { absolute_path: '/repo/.env' }, cwd: '/repo' },
    config,
  );
  assert.equal(decision.ruleId, 'no-secret-files');
  assert.equal(evaluate({ harness: 'claude', tool: 'Read', args: { file_path: 'keys/prod.pem' }, cwd: '/repo' }, config).action, 'deny');
  assert.equal(evaluate({ harness: 'agy', tool: 'view_file', args: { AbsolutePath: '/home/u/.ssh/id_rsa' }, cwd: '/repo' }, config).action, 'deny');
});

test('ordinary work is never blocked', () => {
  const ok = [
    { harness: 'claude', tool: 'Bash', args: { command: 'npm test' } },
    { harness: 'pi', tool: 'bash', args: { command: 'git status' } },
    { harness: 'gemini', tool: 'read_file', args: { absolute_path: 'src/app.ts' } },
    { harness: 'copilot', tool: 'edit', args: { path: 'src/app.ts' } },
    { harness: 'agy', tool: 'write_to_file', args: { TargetFile: 'README.md' } },
    { harness: 'claude', tool: 'Bash', args: { command: 'git push origin main' } },
  ];
  for (const request of ok) {
    assert.equal(evaluate({ ...request, cwd: '/tmp' }, config).action, 'allow', JSON.stringify(request));
  }
});

test('an empty rule set allows everything (guards off by default)', () => {
  for (const harness of ['pi', 'claude', 'gemini', 'agy']) {
    assert.equal(evaluate({ harness, tool: 'bash', args: { command: 'rm -rf /' } }, { rules: [] }).action, 'allow');
  }
});

test('disabled rules are skipped', () => {
  const disabled = { rules: [{ ...config.rules[1], enabled: false }] };
  assert.equal(evaluate(rmRf, disabled).action, 'allow');
});

test('anyArg scans every string in the args tree', () => {
  const cfg = parseConfig('{ "rules": [{ "id": "leak", "when": [{ "anyArg": true, "contains": "AKIA" }] }] }');
  const decision = evaluate({ harness: 'claude', tool: 'Write', args: { content: 'key = "AKIAIOSFODNN7EXAMPLE"' } }, cfg);
  assert.equal(decision.action, 'deny');
  assert.equal(evaluate({ harness: 'claude', tool: 'Write', args: { content: 'nothing here' } }, cfg).action, 'allow');
});

test('not: true inverts a condition', () => {
  const cfg = parseConfig('{ "rules": [{ "id": "only-tests", "tools": ["shell"], "when": [{ "arg": "command", "equals": "npm test", "not": true }] }] }');
  assert.equal(evaluate({ harness: 'claude', tool: 'Bash', args: { command: 'npm test' } }, cfg).action, 'allow');
  assert.equal(evaluate({ harness: 'claude', tool: 'Bash', args: { command: 'rm -rf build' } }, cfg).action, 'deny');
});

test('a broken config throws instead of silently allowing', () => {
  assert.throws(() => parseConfig('{ "rules": [{ "id": "x" }] }'), /non-empty array/);
  assert.throws(() => parseConfig('{ "rules": [{ "id": "x", "when": [{ "regex": "(" }] }] }'), /invalid regex/);
  assert.throws(() => parseConfig('{ "rules": [{ "id": "x", "action": "nope", "when": [{ "arg": "command", "equals": "a" }] }] }'), /action must be/);
});

test('normalize never mutates the harness payload', () => {
  const args = { command: 'npm test' };
  const snapshot = JSON.stringify(args);
  normalize({ harness: 'claude', tool: 'Bash', args });
  assert.equal(JSON.stringify(args), snapshot);
});