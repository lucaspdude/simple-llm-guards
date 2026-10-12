#!/usr/bin/env node
// Decide the next version from the commits since the last tag.
//
//   feat: ...            -> minor
//   fix/perf/refactor:   -> patch
//   BREAKING CHANGE / !  -> major
//   chore/docs/test/ci:  -> no release
//
// Prints the new version on stdout. Exits 1 when there is nothing to release,
// which is how the workflow knows to stop without failing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function lastTag() {
  try {
    return run(['describe', '--tags', '--abbrev=0']);
  } catch {
    return null;
  }
}

function range(tag) {
  return tag ? `${tag}..HEAD` : 'HEAD';
}

function commits(tag) {
  const out = run(['log', range(tag), '--pretty=format:%s%n%b']);
  return out ? out.split('\n').filter(Boolean) : [];
}

function bump(current, kind) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const current = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const messages = commits(lastTag());
const joined = messages.join('\n');

let kind = null;
for (const line of messages) {
  if (/^(\w+)(\([^)]*\))?!:/.test(line) || /^BREAKING[ -]CHANGE/m.test(joined)) { kind = 'major'; break; }
  const type = line.match(/^(\w+)(\([^)]*\))?:/)?.[1];
  if (type === 'feat') kind = kind === 'major' ? 'major' : 'minor';
  else if (['fix', 'perf', 'refactor'].includes(type)) kind = kind ? kind : 'patch';
}

if (!kind) {
  console.error(`nothing to release since ${lastTag() ?? 'the beginning'} (${messages.length} commits, none user-facing)`);
  process.exit(1);
}

const next = bump(current, kind);
console.log(next);