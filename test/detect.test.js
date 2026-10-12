import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, detectAll, installedHarnesses, which, HARNESS_INFO } from '../src/detect.js';
import { HARNESSES } from '../src/normalize.js';

/** os.homedir() reads $HOME on POSIX, so a fake home makes detection deterministic. */
function withHome(dir, fn) {
  const saved = process.env.HOME;
  process.env.HOME = dir;
  try { return fn(); } finally { process.env.HOME = saved; }
}

const EMPTY_HOME = path.join(os.tmpdir(), 'guards-empty-home');
fs.mkdirSync(EMPTY_HOME, { recursive: true });

const TMP = path.join(os.tmpdir(), 'guards-bin');
fs.mkdirSync(TMP, { recursive: true });
for (const name of ['pi', 'omp']) {
  const bin = path.join(TMP, name);
  fs.writeFileSync(bin, '#!/bin/sh\n');
  fs.chmodSync(bin, 0o755);
}

test('which finds an executable on PATH and skips a non-executable file', () => {
  const notExec = path.join(TMP, 'claude');
  fs.writeFileSync(notExec, 'x');
  fs.chmodSync(notExec, 0o644);
  assert.equal(which('pi', { PATH: TMP }), path.join(TMP, 'pi'));
  assert.equal(which('claude', { PATH: TMP }), null, 'a file without +x is not a command');
  assert.equal(which('does-not-exist-anywhere', { PATH: TMP }), null);
  fs.rmSync(notExec);
});

test('which ignores PATH entries that do not exist instead of throwing', () => {
  assert.doesNotThrow(() => which('omp', { PATH: '/nope:/also-nope' }));
  assert.equal(which('omp', { PATH: '/nope:/also-nope' }), null);
});

test('detection reports which signal proved the harness is here', () => {
  const byBinary = detect('pi', { PATH: TMP });
  assert.equal(byBinary.present, true);
  assert.equal(byBinary.via, 'binario');
  assert.equal(byBinary.binary, path.join(TMP, 'pi'));

  const missing = withHome(EMPTY_HOME, () => detect('copilot', { PATH: '/nonexistent-dir' }));
  assert.equal(missing.present, false, 'no binary and no config dir means absent');
  assert.equal(missing.via, null);
});

test('a harness found only by its config directory still counts as present', () => {
  // omp is on this machine through its config dir even when PATH is empty.
  const omp = detect('omp', { PATH: '/nonexistent-dir' });
  assert.equal(omp.present, true);
  assert.equal(omp.via, 'config');
  assert.ok(omp.configDir.endsWith(path.join('.omp', 'agent')));
});

test('every harness is described, found or not', () => {
  const all = detectAll({ PATH: TMP });
  assert.deepEqual(all.map((d) => d.harness), HARNESSES);
  for (const d of all) {
    assert.equal(typeof d.present, 'boolean', d.harness);
    assert.ok(d.label, d.harness);
  }
  assert.ok(installedHarnesses({ PATH: TMP }).includes('pi'));
  assert.deepEqual(withHome(EMPTY_HOME, () => installedHarnesses({ PATH: '/nonexistent-dir' })), []);
});

test('the info table has a binary and a config dir for every harness', () => {
  for (const harness of HARNESSES) {
    const info = HARNESS_INFO[harness];
    assert.ok(info.bin, harness);
    assert.ok(Array.isArray(info.dir) && info.dir.length, harness);
  }
});

test('an unknown harness reports as absent instead of throwing', () => {
  const d = detect('codex');
  assert.equal(d.present, false);
  assert.equal(d.label, 'codex');
});