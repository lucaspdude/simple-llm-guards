// Rule loading. The file is JSONC (JSON + // and /* */ comments) because a guard
// set is meant to be read and edited by a human, not generated.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Strip comments from JSONC without touching `//` inside strings. */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      else if (c === '\n') out += c;
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

export function defaultConfigPath() {
  if (process.env.GUARDS_CONFIG) return process.env.GUARDS_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'simple-llm-guards', 'guards.jsonc');
}

const VALID_ACTIONS = new Set(['deny', 'allow']);

function validateRule(rule, index, file) {
  const where = `${file}: rules[${index}]`;
  if (!rule || typeof rule !== 'object') throw new Error(`${where}: expected an object`);
  if (!rule.id) throw new Error(`${where}: missing "id"`);
  const action = rule.action ?? 'deny';
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`${where} ("${rule.id}"): action must be "deny" or "allow", got "${action}"`);
  }
  if (!Array.isArray(rule.when) || rule.when.length === 0) {
    throw new Error(`${where} ("${rule.id}"): "when" must be a non-empty array of conditions`);
  }
  for (const [i, cond] of rule.when.entries()) {
    const cwhere = `${where} ("${rule.id}") when[${i}]`;
    if (Array.isArray(cond.anyOf)) {
      if (cond.anyOf.length === 0) throw new Error(`${cwhere}: "anyOf" must not be empty`);
      cond.anyOf.forEach((sub, j) => validateCondition(sub, `${cwhere}.anyOf[${j}]`));
      continue;
    }
    validateCondition(cond, cwhere);
  }
  return { ...rule, action };
}

function validateCondition(cond, cwhere) {
  {
    if (Array.isArray(cond.anyOf)) throw new Error(`${cwhere}: anyOf cannot nest anyOf`);
    const matcher = cond.regex !== undefined ? 'regex'
      : cond.contains !== undefined ? 'contains'
      : cond.equals !== undefined ? 'equals'
      : cond.glob !== undefined ? 'glob'
      : null;
    if (!matcher) throw new Error(`${cwhere}: needs one of regex | contains | equals | glob`);
    if (cond.regex !== undefined) {
      try { new RegExp(cond.regex, cond.flags ?? ''); }
      catch (e) { throw new Error(`${cwhere}: invalid regex — ${e.message}`); }
    }
    if (matcher !== 'glob' && !cond.arg && !cond.anyArg) {
      throw new Error(`${cwhere}: needs "arg" (a canonical argument name) or "anyArg": true`);
    }
    if (cond.glob !== undefined && !cond.arg) {
      throw new Error(`${cwhere}: "glob" needs an "arg" holding the path`);
    }
  }
}

/** Parse + validate a rule set. Throws with a file-position message on bad input. */
export function parseConfig(text, file = '<inline>') {
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new Error(`${file}: invalid JSON — ${e.message}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${file}: expected a JSON object`);
  const rules = raw.rules ?? [];
  if (!Array.isArray(rules)) throw new Error(`${file}: "rules" must be an array`);
  const seen = new Set();
  return {
    version: raw.version ?? 1,
    rules: rules.map((r, i) => {
      const rule = validateRule(r, i, file);
      if (seen.has(rule.id)) throw new Error(`${file}: duplicate rule id "${rule.id}"`);
      seen.add(rule.id);
      return rule;
    }),
  };
}

/** Read + validate the rule set at `file`. A missing file is an empty rule set. */
export function loadConfig(file = defaultConfigPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No file is a valid, empty rule set: every harness then behaves exactly
    // as it did before guards existed.
    return { version: 1, rules: [], file, missing: true };
  }
  return { ...parseConfig(text, file), file };
}