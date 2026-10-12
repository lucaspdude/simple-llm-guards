import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'src', 'cli.js');

/**
 * Install into a throwaway HOME so the developer's real agent config is never
 * touched — which is exactly the mistake these tests exist to prevent.
 */
function sandbox(name) {
  const home = path.join(os.tmpdir(), `guards-home-${name}-${process.pid}`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function guards(home, args, env = {}) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, GUARDS_CONFIG: path.join(home, 'rules.jsonc'), ...env },
    });
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

const read = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

test('agy install merges into a hooks.json another tool already owns', () => {
  const home = sandbox('agy-merge');
  const file = path.join(home, '.gemini', 'config', 'hooks.json');
  // Stand-in for Orca's real hook, which lives in this exact file.
  fs.writeFileSync(file, JSON.stringify({ 'orca-status': { PreInvocation: [{ hooks: [] }] } }, null, 2));

  guards(home, ['init']);
  guards(home, ['install', 'agy']);

  const merged = read(file);
  assert.ok(merged['orca-status'], "another tool's hook must survive");
  assert.ok(merged['simple-llm-guards'], 'our hook is added alongside it');
  assert.deepEqual(Object.keys(merged).sort(), ['orca-status', 'simple-llm-guards']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy uninstall removes only our key, never the whole file', () => {
  const home = sandbox('agy-remove');
  const file = path.join(home, '.gemini', 'config', 'hooks.json');
  fs.writeFileSync(file, JSON.stringify({ 'orca-status': { PreInvocation: [{ hooks: [] }] } }, null, 2));

  guards(home, ['init']);
  guards(home, ['install', 'agy']);
  guards(home, ['uninstall', 'agy']);

  const after = read(file);
  assert.ok(after, 'the file must still exist — Orca is still using it');
  assert.deepEqual(Object.keys(after), ['orca-status']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('claude install and uninstall leave the rest of settings.json intact', () => {
  const home = sandbox('claude');
  const file = path.join(home, '.claude', 'settings.json');
  const original = {
    model: 'opus',
    hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));

  guards(home, ['init']);
  guards(home, ['install', 'claude']);
  const installed = read(file);
  assert.equal(installed.model, 'opus', 'unrelated settings survive');
  assert.equal(installed.hooks.SessionStart.length, 1);
  assert.ok(JSON.stringify(installed.hooks.PreToolUse).includes('simple-llm-guards'));

  guards(home, ['uninstall', 'claude']);
  const after = read(file);
  assert.equal(after.model, 'opus');
  assert.ok(after.hooks.SessionStart, 'another event keeps its hook');
  assert.deepEqual(after.hooks.PreToolUse, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('installing twice does not duplicate our entry', () => {
  const home = sandbox('idem');
  const file = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: {} }, null, 2));
  guards(home, ['init']);
  guards(home, ['install', 'claude']);
  guards(home, ['install', 'claude']);
  const entries = read(file).hooks.PreToolUse.filter((g) => JSON.stringify(g).includes('simple-llm-guards'));
  assert.equal(entries.length, 1, 'idempotent');
  fs.rmSync(home, { recursive: true, force: true });
});

test('uninstalling something that was never installed is a no-op', () => {
  const home = sandbox('noop');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));
  const out = guards(home, ['uninstall', 'claude']);
  assert.match(out, /nothing installed/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a dry run writes nothing at all', () => {
  const home = sandbox('dry');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));
  const before = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
  guards(home, ['install', 'claude', '--dry-run']);
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the backup written before a merge holds the original file', () => {
  const home = sandbox('bak');
  const file = path.join(home, '.claude', 'settings.json');
  const original = { hooks: {}, marker: 'before' };
  fs.writeFileSync(file, JSON.stringify(original, null, 2));
  guards(home, ['init']);
  guards(home, ['install', 'claude']);
  assert.deepEqual(read(`${file}.bak`), original);
  fs.rmSync(home, { recursive: true, force: true });
});