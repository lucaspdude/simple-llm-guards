#!/usr/bin/env node
// Decide which version to publish.
//
// The last git tag is the source of truth, not package.json. That way the
// release job never has to commit a version bump back to main — which is what
// lets it work on a repository where main is protected and only pull requests
// are allowed to land.
//
//   no tag at all        -> first release: whatever package.json says
//   feat: ...            -> minor
//   fix/perf/refactor:   -> patch
//   BREAKING CHANGE / !  -> major
//   chore/docs/test/ci:  -> nothing to publish
//
// Prints the version on stdout. Exits 1 when there is nothing to release,
// which is how the workflow stops without failing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const run = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const git = (args, fallback = null) => {
  try {
    return run(args);
  } catch {
    return fallback;
  }
};

function lastTag() {
  return git(['describe', '--tags', '--abbrev=0']);
}

function tagVersion(tag) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(tag ?? '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function commitSubjects(tag) {
  const out = git(['log', `${tag}..HEAD`, '--pretty=format:%s%n%b'], '') ?? '';
  return out.split('\n').filter(Boolean);
}

function bump(current, kind) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const manifest = new URL('../package.json', import.meta.url);
const declared = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
const tag = lastTag();
const current = tagVersion(tag) ?? declared;

if (!tag) {
  // First ever release: publish what the manifest declares rather than
  // jumping a minor version before anything has shipped.
  console.log(declared);
  process.exit(0);
}

const subjects = commitSubjects(tag);
const bodies = subjects.join('\n');

let kind = null;
for (const line of subjects) {
  const breaking = /^(\w+)(\([^)]*\))?!:/.test(line) || /^BREAKING[ -]CHANGE/m.test(bodies);
  if (breaking) { kind = 'major'; break; }
  const type = line.match(/^(\w+)(\([^)]*\))?:/)?.[1];
  if (type === 'feat') kind = kind === 'major' ? 'major' : 'minor';
  else if (['fix', 'perf', 'refactor'].includes(type) && !kind) kind = 'patch';
}

if (!kind) {
  console.error(`nothing to release since ${tag} (${subjects.length} commits, none user-facing)`);
  process.exit(1);
}

console.log(bump(current, kind));