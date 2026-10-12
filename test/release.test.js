import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'release.mjs');

/** A throwaway git repo whose package.json the script can read. */
function repo(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-rel-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  const commit = (message) => {
    fs.writeFileSync(path.join(dir, 'file.txt'), message);
    git('add', '-A');
    git('commit', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version }));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'release.mjs'));
  commit('chore: initial');
  return { dir, commit, git };
}

function nextVersion(dir) {
  // The script resolves package.json relative to itself, so it has to run from
  // inside the repo it is versioning — exactly how the workflow invokes it.
  try {
    return execFileSync(process.execPath, [path.join(dir, 'scripts', 'release.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  } catch (e) {
    return { exit: e.status, stderr: String(e.stderr) };
  }
}

test('the very first release publishes the version the manifest declares', () => {
  // Nothing has shipped yet, so there is nothing to bump past: publishing
  // 0.1.0 as-is beats jumping straight to 0.2.0 on the first merge.
  const r = repo('0.1.0');
  r.commit('feat: the first thing');
  r.commit('fix: a bug');
  assert.equal(nextVersion(r.dir), '0.1.0');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('the last tag outranks a stale version in package.json', () => {
  // The release job never commits its bump, so main's manifest stays behind on
  // purpose. Deriving from the tag is what keeps the sequence correct.
  const r = repo('0.1.0');
  r.git('tag', '-a', 'v3.2.1', '-m', 'v3.2.1');
  r.commit('feat: something new');
  assert.equal(nextVersion(r.dir), '3.3.0');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('fix bumps patch, feat bumps minor, breaking bumps major', () => {
  const r = repo('1.4.7');
  r.git('tag', '-a', 'v1.4.7', '-m', 'v1.4.7');
  r.commit('fix: a bug');
  assert.equal(nextVersion(r.dir), '1.4.8');

  r.git('tag', '-a', 'v1.4.8', '-m', 'v1.4.8');
  r.commit('feat: a feature');
  assert.equal(nextVersion(r.dir), '1.5.0');

  r.git('tag', '-a', 'v1.5.0', '-m', 'v1.5.0');
  r.commit('feat!: a breaking feature');
  assert.equal(nextVersion(r.dir), '2.0.0');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('the strongest signal across several commits wins', () => {
  const r = repo('0.3.0');
  r.git('tag', '-a', 'v0.3.0', '-m', 'v0.3.0');
  r.commit('fix: small');
  r.commit('feat: bigger');
  assert.equal(nextVersion(r.dir), '0.4.0');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('commits that are not user-facing do not trigger a release', () => {
  const r = repo('0.5.0');
  r.git('tag', '-a', 'v0.5.0', '-m', 'v0.5.0');
  r.commit('chore: tidy up');
  r.commit('docs: fix a typo');
  r.commit('ci: tweak the workflow');
  const out = nextVersion(r.dir);
  assert.equal(typeof out, 'object', 'the script must refuse, not guess');
  assert.match(out.stderr, /nothing to release/);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a BREAKING CHANGE footer counts even when the subject is only fix', () => {
  const r = repo('2.1.0');
  r.git('tag', '-a', 'v2.1.0', '-m', 'v2.1.0');
  const git = (...args) => execFileSync('git', args, { cwd: r.dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(r.dir, 'file.txt'), 'x');
  git('add', '-A');
  git('commit', '-m', 'fix: changed the rules file shape', '-m', 'BREAKING CHANGE: existing guards.jsonc needs a migration');
  assert.equal(nextVersion(r.dir), '3.0.0');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a refactor alone is a patch, not a release', () => {
  const r = repo('0.9.9');
  r.git('tag', '-a', 'v0.9.9', '-m', 'v0.9.9');
  r.commit('refactor: rename an internal helper');
  assert.equal(nextVersion(r.dir), '0.9.10');
  fs.rmSync(r.dir, { recursive: true, force: true });
});