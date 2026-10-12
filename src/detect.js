// Which harnesses are actually on this machine.
//
// Installing into a harness that was never run leaves a config file nobody will
// ever read, and installing into one the user does not use is worse: it looks
// like the guard is active when it is not. So we ask the filesystem first and
// let the user confirm before anything is written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESSES } from './normalize.js';

/** Where each harness lives: its binary, and the directory it creates when run. */
export const HARNESS_INFO = {
  pi: { bin: 'pi', dir: ['.pi', 'agent'], label: 'pi' },
  omp: { bin: 'omp', dir: ['.omp', 'agent'], label: 'omp' },
  claude: { bin: 'claude', dir: ['.claude'], label: 'Claude Code' },
  copilot: { bin: 'copilot', dir: ['.copilot'], label: 'Copilot CLI' },
  gemini: { bin: 'gemini', dir: ['.gemini'], label: 'Gemini CLI' },
  agy: { bin: 'agy', dir: ['.gemini', 'antigravity-cli'], label: 'Antigravity CLI' },
};

/** Resolve a command through PATH. No shell, no spawn. */
export function which(bin, env = process.env) {
  if (!bin) return null;
  if (bin.includes(path.sep)) return isExecutable(bin) ? bin : null;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    if (isExecutable(full)) return full;
  }
  return null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function configDirOf(harness) {
  const info = HARNESS_INFO[harness];
  return info ? path.join(os.homedir(), ...info.dir) : null;
}

/**
 * One harness: is it here, and what proves it.
 * `via` is the strongest signal we found — a binary on PATH beats a config
 * directory, because a leftover directory outlives an uninstall.
 */
export function detect(harness, env = process.env) {
  const info = HARNESS_INFO[harness];
  if (!info) return { harness, present: false, via: null, binary: null, configDir: null, label: harness };

  const binary = which(info.bin, env);
  const configDir = configDirOf(harness);
  const hasDir = Boolean(configDir && fs.existsSync(configDir));

  return {
    harness,
    label: info.label,
    present: Boolean(binary) || hasDir,
    via: binary ? 'binario' : hasDir ? 'config' : null,
    binary,
    configDir,
  };
}

/** Every harness, present or not, in display order. */
export function detectAll(env = process.env) {
  return HARNESSES.map((h) => detect(h, env));
}

/** Just the ones that are actually installed. */
export function installedHarnesses(env = process.env) {
  return detectAll(env).filter((d) => d.present).map((d) => d.harness);
}