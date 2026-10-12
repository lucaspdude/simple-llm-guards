// Where the hook process actually lives after installation.
//
// `npx simple-llm-guards` runs from a throwaway cache directory
// (~/.npm/_npx/<hash>/node_modules/...), which npm is free to delete. Config
// files pointing there would silently stop guarding the next time the user runs
// npx for something else. So installation copies the runtime to a stable path
// once, and every generated config points at that.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Read the version from the package manifest next to this file. */
export function packageVersion(root = HERE) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** True when we are running from a git checkout rather than an installed package. */
export function isCheckout(root = HERE) {
  return fs.existsSync(path.join(root, '.git'));
}

/**
 * Stable home for the runtime, always beside the rules file it serves.
 * Keep the two together: pointing GUARDS_CONFIG somewhere else moves both, so
 * there is never a half-migrated install with rules in one place and a hook
 * binary in another.
 */
export function runtimeDir(configFile) {
  if (configFile) return path.join(path.dirname(configFile), 'runtime');
  const base = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'),
    'simple-llm-guards',
  );
  return path.join(base, 'runtime');
}

function readMarker(root) {
  try {
    return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Ensure a current copy of the runtime exists and return its root.
 *
 * - A checkout is used in place: editing the repo and re-installing is the
 *   fastest loop, and the repo path does not move under you.
 * - An installed package is copied out of the npx cache, once per version.
 */
export function ensureRuntime({ configFile, version = packageVersion() } = {}) {
  const target = runtimeDir(configFile);

  if (isCheckout()) {
    return { root: HERE, version, copied: false, reason: 'checkout' };
  }
  if (path.resolve(HERE) === path.resolve(target)) {
    return { root: HERE, version, copied: false, reason: 'already in place' };
  }
  if (readMarker(target) === version && fs.existsSync(path.join(target, 'src', 'guard-hook.js'))) {
    return { root: target, version, copied: false, reason: 'current' };
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(HERE, 'src'), path.join(target, 'src'), { recursive: true });
  fs.copyFileSync(path.join(HERE, 'package.json'), path.join(target, 'package.json'));
  fs.writeFileSync(path.join(target, 'VERSION'), `${version}\n`);
  return { root: target, version, copied: true, reason: 'installed' };
}

/** Is the installed runtime older than the package being run right now? */
export function runtimeIsStale({ configFile, version = packageVersion() } = {}) {
  if (isCheckout()) return false;
  return readMarker(runtimeDir(configFile)) !== version;
}

/** Paths inside a runtime root, used to build hook commands and extensions. */
export function entryPaths(root) {
  return {
    root,
    hook: path.join(root, 'src', 'guard-hook.js'),
    pi: path.join(root, 'src', 'adapters', 'pi.js'),
  };
}