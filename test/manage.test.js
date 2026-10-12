import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { add, buildRule, describeRule, remove, snapshot, toggle } from '../src/manage.js';
import { listRules } from '../src/rules-edit.js';
import { parseConfig } from '../src/rules.js';
import { STARTER_RULES } from '../src/starter.js';
import * as piAdapter from '../src/adapters/pi.js';

function freshFile(name) {
  const file = path.join(os.tmpdir(), `guards-manage-${name}-${process.pid}.jsonc`);
  fs.writeFileSync(file, STARTER_RULES);
  return file;
}

test('snapshot reports id, state and the parsed rule', () => {
  const state = snapshot(freshFile('snap'));
  assert.equal(state.rules.length, 5);
  assert.equal(state.error, null);
  assert.deepEqual(state.rules[1].tools, ['shell']);
  assert.ok(state.rules[1].enabled);
});

test('a broken file surfaces an error instead of throwing', () => {
  const file = path.join(os.tmpdir(), `guards-manage-broken-${process.pid}.jsonc`);
  fs.writeFileSync(file, '{ "rules": [ { "id": "x" } ] }');
  const state = snapshot(file);
  assert.match(state.error, /non-empty array/);
  fs.rmSync(file);
});

test('toggle flips the flag and the file stays valid', () => {
  const file = freshFile('toggle');
  assert.deepEqual(toggle(file, 'no-rm-rf-root'), { id: 'no-rm-rf-root', enabled: false });
  assert.equal(snapshot(file).rules.find((r) => r.id === 'no-rm-rf-root').enabled, false);
  toggle(file, 'no-rm-rf-root');
  assert.equal(snapshot(file).rules.find((r) => r.id === 'no-rm-rf-root').enabled, true);
  assert.ok(parseConfig(fs.readFileSync(file, 'utf8'), file));
  fs.rmSync(file);
});

test('remove deletes exactly one rule and keeps the comments', () => {
  const file = freshFile('remove');
  remove(file, 'no-drop-database');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(listRules(text).length, 4);
  assert.ok(text.includes('// simple-llm-guards'));
  fs.rmSync(file);
});

test('add refuses a duplicate id before touching the file', () => {
  const file = freshFile('dup');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => add(file, { id: 'no-rm-rf-root', when: [{ arg: 'command', equals: 'a' }] }), /já existe/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.rmSync(file);
});

test('add refuses an invalid rule and leaves the file untouched', () => {
  const file = freshFile('bad');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => add(file, { id: 'broken', when: [{ arg: 'command', regex: '(' }] }), /invalid regex/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.rmSync(file);
});

test('slugify turns a label into a rule id', () => {
  assert.equal(buildRule({ id: 'Bloquear deploy!', templateKey: 'command', value: 'kubectl\\s+delete' }).id, 'bloquear-deploy');
});

test('each wizard template produces a rule the engine honours', () => {
  const cases = [
    ['command', 'npm\\s+publish\\b', { command: 'npm publish' }],
    ['path', '**/.env', { file_path: '/repo/.env' }],
    ['text', 'AKIA', { content: 'key AKIA123' }],
  ];
  for (const [kind, value, args] of cases) {
    const rule = buildRule({ id: `wizard-${kind}`, templateKey: kind, value });
    parseConfig(JSON.stringify({ rules: [rule] }), 'wizard');
    assert.ok(rule.when.length, kind);
    assert.ok(describeRule(rule).length, kind);
    assert.ok(args);
  }
});

test('the custom template takes raw JSON', () => {
  const rule = buildRule({
    id: 'custom',
    templateKey: 'custom',
    templateText: '{"tools":["shell"],"when":[{"arg":"command","equals":"never"}]}',
  });
  assert.equal(rule.tools[0], 'shell');
  assert.equal(rule.when[0].equals, 'never');
});

test('a wizard rule with a broken regex is rejected', () => {
  assert.throws(() => buildRule({ id: 'x', templateKey: 'command', value: '(' }), /invalid regex/);
});

// --- the /guards manage command inside pi and omp -------------------------

function fakeRuntime() {
  const commands = [];
  return {
    commands,
    pi: { on: () => {}, registerCommand: (name, spec) => commands.push([name, spec]) },
  };
}

/** A ctx.ui whose answers come from a script, recording every dialog shown. */
function fakeCtx(script) {
  const shown = [];
  const answers = [...script];
  return {
    shown,
    hasUI: true,
    ui: {
      select: async (title, options) => {
        shown.push({ title, options });
        const next = answers.shift();
        return next === 'first' ? options[0] : next ?? undefined;
      },
      input: async (title) => {
        shown.push({ title });
        return answers.shift();
      },
      confirm: async () => answers.shift() !== 'no',
      notify: (message, type) => shown.push({ notify: message, type }),
    },
  };
}

test('the extension registers a /guards command', () => {
  const { commands, pi } = fakeRuntime();
  piAdapter.createExtension(freshFile('cmd'))(pi);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'guards');
  assert.ok(commands[0][1].description);
});

test('/guards manage toggles a rule and redraws the list', async () => {
  const file = freshFile('menu-toggle');
  const { commands, pi } = fakeRuntime();
  piAdapter.createExtension(file)(pi);
  const [, spec] = commands[0];

  const ctx = fakeCtx(['first', 'desligar', undefined]); // pick rule 1, disable it, close
  await spec.handler('manage', ctx);

  const rule = snapshot(file).rules[0];
  assert.equal(rule.enabled, false, 'the picked rule must be off');
  assert.ok(ctx.shown.filter((s) => s.title?.startsWith('guardas')).length >= 2, 'the list redraws');
  assert.ok(ctx.shown.some((s) => s.notify?.includes('desligada')));
  fs.rmSync(file);
});

test('/guards manage refuses to act when there is no UI', async () => {
  const file = freshFile('menu-noui');
  const { commands, pi } = fakeRuntime();
  piAdapter.createExtension(file)(pi);
  const before = fs.readFileSync(file, 'utf8');
  const ctx = { hasUI: false, ui: { notify: () => {} } };
  await commands[0][1].handler('manage', ctx);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('bare /guards opens the menu, and a stray word explains itself', async () => {
  const file = freshFile('menu-args');
  const { commands, pi } = fakeRuntime();
  piAdapter.createExtension(file)(pi);

  // No argument is the friendly case: just open the menu.
  const bare = fakeCtx([undefined]);
  await commands[0][1].handler('', bare);
  assert.ok(bare.shown.some((s) => s.title?.startsWith('guardas')));

  // A word that is not "manage" is a typo, not an invitation to guess.
  const notices = [];
  await commands[0][1].handler('install', { hasUI: true, ui: { notify: (m) => notices.push(m) } });
  assert.match(notices[0], /\/guards manage/);
});

test('the menu shows state and the create entry', async () => {
  const file = freshFile('menu-show');
  const { commands, pi } = fakeRuntime();
  piAdapter.createExtension(file)(pi);
  const ctx = fakeCtx([undefined]);
  await commands[0][1].handler('manage', ctx);
  const list = ctx.shown.find((s) => s.title?.startsWith('guardas'));
  assert.equal(list.options.length, 6); // 5 rules + create
  assert.match(list.options[0], /^● on {2}no-secret-files/);
  assert.match(list.options.at(-1), /criar nova guarda/);
  fs.rmSync(file);
});