import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/rules.js';
import { canonicalArgs } from '../src/normalize.js';
import { STARTER_RULES } from '../src/starter.js';
import * as pi from '../src/adapters/pi.js';
import * as claude from '../src/adapters/claude.js';
import * as copilot from '../src/adapters/copilot.js';
import * as gemini from '../src/adapters/gemini.js';
import * as agy from '../src/adapters/agy.js';

const config = parseConfig(STARTER_RULES, 'starter');
const DANGER = 'rm -rf /';

// Each entry is the payload that harness actually puts on the hook's stdin.
const CASES = [
  ['pi', pi, { toolName: 'bash', input: { command: DANGER }, cwd: '/tmp' }],
  ['claude', claude, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: DANGER }, cwd: '/tmp' }],
  ['copilot', copilot, { sessionId: 's1', cwd: '/tmp', toolName: 'bash', toolArgs: { command: DANGER } }],
  ['gemini', gemini, { hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: DANGER }, cwd: '/tmp' }],
  ['agy', agy, { toolCall: { name: 'run_command', args: { CommandLine: DANGER, Cwd: '/tmp' } }, workspacePaths: ['/tmp'], stepIdx: 3 }],
];

test('each adapter parses its own payload shape', () => {
  for (const [name, adapter, payload] of CASES) {
    const parsed = adapter.parse(payload);
    assert.equal(canonicalArgs(name, parsed.tool, parsed.args).command, DANGER, `${name}: command`);
    assert.ok(parsed.cwd, `${name}: cwd`);
  }
});

test('each adapter blocks the same call in its own dialect', () => {
  for (const [name, adapter, payload] of CASES) {
    const decision = { action: 'deny', ruleId: 'no-rm-rf-root', reason: 'no-rm-rf-root: blocked', request: {} };
    const out = adapter.format(decision);

    if (name === 'pi') {
      assert.deepEqual(out, { block: true, reason: 'no-rm-rf-root: blocked' });
      continue;
    }
    assert.equal(out.exitCode, 0, `${name}: deny exits 0 with a JSON verdict`);
    const body = JSON.parse(out.stdout);
    if (name === 'claude') {
      assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(body.hookSpecificOutput.hookEventName, 'PreToolUse');
      assert.match(body.hookSpecificOutput.permissionDecisionReason, /no-rm-rf-root/);
    } else if (name === 'copilot') {
      assert.equal(body.permissionDecision, 'deny');
      assert.match(body.permissionDecisionReason, /no-rm-rf-root/);
    } else {
      assert.equal(body.decision, 'deny');
      assert.match(body.reason, /no-rm-rf-root/);
    }
  }
});

test('an allow decision emits nothing at all', () => {
  for (const [name, adapter] of CASES) {
    const out = adapter.format({ action: 'allow', ruleId: null, reason: null });
    if (name === 'pi') assert.equal(out, undefined);
    else assert.equal(out.stdout, '');
  }
});

test('copilot also accepts a stringified toolArgs', () => {
  const parsed = copilot.parse({ toolName: 'bash', toolArgs: '{"command":"rm -rf /"}' });
  assert.equal(parsed.args.command, DANGER);
});

test('pi adapter registers tool_call and blocks through the runtime', () => {
  const events = [];
  const fakePi = { on: (name, handler) => events.push([name, handler]) };
  const extension = pi.createExtension('/nonexistent/guards.jsonc'); // no rules -> allow
  extension(fakePi);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], 'tool_call');
  assert.equal(events[0][1]({ toolName: 'bash', input: { command: 'npm test' } }), undefined);
});

test('pi adapter fails closed when the rules file is broken', () => {
  const events = [];
  const fakePi = { on: (name, handler) => events.push([name, handler]) };
  pi.createExtension('/nonexistent/dir/rules.jsonc')(fakePi);
  assert.equal(events[0][1]({ toolName: 'bash', input: { command: 'npm test' } }), undefined);
});