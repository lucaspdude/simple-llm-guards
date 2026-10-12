import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendRule, editRulesFile, listRules, removeRule, setEnabled } from '../src/rules-edit.js';
import { loadConfig, parseConfig } from '../src/rules.js';
import { STARTER_RULES } from '../src/starter.js';
import { evaluate } from '../src/engine.js';

const base = STARTER_RULES;

test('lists every rule from the starter file', () => {
  const rules = listRules(base);
  assert.equal(rules.length, 5);
  assert.deepEqual(rules.map((r) => r.id), [
    'no-secret-files', 'no-rm-rf-root', 'no-git-destruction', 'no-drop-database', 'no-ssh-key-write',
  ]);
  assert.ok(rules.every((r) => r.enabled));
});

test('an id inside a string value is not mistaken for the id', () => {
  const text = `{
  "rules": [
    { "id": "real-one", "reason": "the id field says \\"id\\" inside a string", "when": [{ "arg": "command", "equals": "x" }] }
  ]
}`;
  assert.equal(listRules(text)[0].id, 'real-one');
});

test('disabling preserves every comment and the rest of the file byte for byte', () => {
  const out = setEnabled(base, 'no-rm-rf-root', false);
  assert.match(out, /"enabled": false,\n\s+"id": "no-rm-rf-root"/);
  assert.ok(out.includes('// simple-llm-guards — one rule set, every harness.'));
  assert.ok(out.includes('// Set "failOpen": true'));

  // Everything that is not the added line is untouched.
  const added = out.split('\n').filter((l) => !l.includes('"enabled": false'));
  const original = base.split('\n');
  assert.deepEqual(added, original);
});

test('enable is the exact inverse of disable', () => {
  const off = setEnabled(base, 'no-rm-rf-root', false);
  assert.equal(setEnabled(off, 'no-rm-rf-root', true), base);
});

test('toggling enabled is honoured by the engine', () => {
  const off = setEnabled(base, 'no-rm-rf-root', false);
  const call = { harness: 'claude', tool: 'Bash', args: { command: 'rm -rf /' }, cwd: '/tmp' };
  assert.equal(evaluate(call, parseConfig(base, 't')).action, 'deny');
  assert.equal(evaluate(call, parseConfig(off, 't')).action, 'allow');
});

test('removing a rule leaves valid JSON and the other rules intact', () => {
  const out = removeRule(base, 'no-rm-rf-root');
  const rules = listRules(out);
  assert.equal(rules.length, 4);
  assert.ok(!rules.some((r) => r.id === 'no-rm-rf-root'));
  assert.deepEqual(parseConfig(out, 't').rules.length, 4);
  assert.equal(evaluate({ harness: 'claude', tool: 'Bash', args: { command: 'rm -rf /' }, cwd: '/tmp' }, parseConfig(out, 't')).action, 'allow');
});

test('removing the first and the last rule both leave valid JSON', () => {
  for (const id of ['no-secret-files', 'no-ssh-key-write']) {
    const out = removeRule(base, id);
    assert.equal(parseConfig(out, 't').rules.length, 4, id);
  }
  // removing every rule leaves an empty, still-valid array
  let text = base;
  for (const id of listRules(text).map((r) => r.id)) text = removeRule(text, id);
  assert.equal(parseConfig(text, 't').rules.length, 0);
});

test('comments survive a removal', () => {
  const out = removeRule(base, 'no-drop-database');
  assert.ok(out.includes('// simple-llm-guards — one rule set, every harness.'));
  assert.ok(out.includes('"id": "no-git-destruction"'));
});

test('appending keeps the indentation of the neighbours', () => {
  const rule = {
    id: 'no-force-push',
    tools: ['shell'],
    // Deliberately narrower than the starter's no-git-destruction, so this
    // test proves the *new* rule is the one doing the blocking.
    when: [{ arg: 'command', regex: 'npm\\s+publish\\b' }],
    reason: 'npm publish so pode rodar depois do teste.',
  };
  const out = appendRule(base, rule);
  assert.equal(parseConfig(out, 't').rules.length, 6);
  assert.match(out, /\n    \{\n      "id": "no-force-push"/);
  assert.ok(out.includes('// simple-llm-guards'));

  // Post-adapter shape: `agy.parse` has already unwrapped toolCall.args.
  const call = { harness: 'agy', tool: 'run_command', args: { CommandLine: 'npm publish' }, cwd: '/tmp' };
  const decision = evaluate(call, parseConfig(out, 't'));
  assert.equal(decision.action, 'deny');
  assert.equal(decision.ruleId, 'no-force-push');
});

test('appending to an empty rules array works', () => {
  const empty = '{ "rules": [] }';
  const out = appendRule(empty, { id: 'x', when: [{ arg: 'command', equals: 'a' }] });
  assert.equal(parseConfig(out, 't').rules.length, 1);
});

test('a rule written inline on one line is still found', () => {
  const text = '{ "rules": [ { "id": "inline-rule", "enabled": false, "when": [{ "arg": "command", "equals": "a" }] } ] }';
  assert.equal(listRules(text)[0].enabled, false);
  assert.equal(listRules(setEnabled(text, 'inline-rule', true))[0].enabled, true);
});

test('asking for a rule that does not exist lists what does', () => {
  assert.throws(() => setEnabled(base, 'nope', false), /não existe \(disponíveis: no-secret-files/);
});

test('editRulesFile writes only when the text actually changed', () => {
  const file = path.join(os.tmpdir(), `guards-edit-${process.pid}.jsonc`);
  fs.writeFileSync(file, base);
  const noop = editRulesFile(file, (t) => t);
  assert.equal(noop.changed, false);
  const done = editRulesFile(file, (t) => setEnabled(t, 'no-rm-rf-root', false));
  assert.equal(done.changed, true);
  assert.equal(loadConfig(file).rules.find((r) => r.id === 'no-rm-rf-root').enabled, false);
  fs.rmSync(file);
});

test('every intermediate state stays loadable', () => {
  let text = base;
  const steps = [
    (t) => setEnabled(t, 'no-rm-rf-root', false),
    (t) => setEnabled(t, 'no-rm-rf-root', true),
    (t) => removeRule(t, 'no-git-destruction'),
    (t) => appendRule(t, { id: 'new', tools: ['shell'], when: [{ arg: 'command', contains: 'x' }], reason: 'r' }),
    (t) => setEnabled(t, 'new', false),
    (t) => removeRule(t, 'new'),
  ];
  for (const [i, step] of steps.entries()) {
    text = step(text);
    assert.ok(parseConfig(text, `step${i}`), `step ${i} must stay valid`);
  }
  void parseConfig;
});