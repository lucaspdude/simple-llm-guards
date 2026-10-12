// The guard engine: one pure function, zero harness knowledge.
//
//   evaluate({ harness, tool, args, cwd }, rules) -> { action, ruleId, reason }
//
// Everything harness-specific lives in adapters/. This file is what all five
// harnesses agree on: the same rules, the same verdict, for the same intent.

import { normalize } from './normalize.js';

/** Glob -> RegExp. Supports `**`, `*` and `?`. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` crosses directory separators; a bare `**` matches anything.
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

const globCache = new Map();
function matchGlob(value, glob) {
  let re = globCache.get(glob);
  if (!re) { re = globToRegExp(glob); globCache.set(glob, re); }
  return re.test(value);
}

/** Every string reachable in the args object, for `anyArg` conditions. */
function collectStrings(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return out; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); collectStrings(v, out, depth + 1); }
  }
  return out;
}

/** Expand `~` and make the path absolute so globs match the same way everywhere. */
export function resolvePath(value, cwd) {
  let p = String(value ?? '');
  if (!p) return '';
  if (p === '~') p = process.env.HOME ?? p;
  else if (p.startsWith('~/')) p = (process.env.HOME ?? '~') + p.slice(1);
  if (!p.startsWith('/')) p = `${cwd}/${p}`;
  return p.replace(/\/{2,}/g, '/');
}

function matchesCondition(cond, request) {
  const { args, cwd } = request;

  // `anyOf` is how a rule says "or": alternative ways of tripping the same guard.
  if (Array.isArray(cond.anyOf)) {
    const anyHit = cond.anyOf.some((sub) => matchesCondition(sub, request));
    return cond.not ? !anyHit : anyHit;
  }

  let hit = false;
  if (cond.glob !== undefined) {
    const raw = args[cond.arg];
    const target = typeof raw === 'string' ? resolvePath(raw, cwd) : '';
    if (target) {
      const globs = Array.isArray(cond.glob) ? cond.glob : [cond.glob];
      hit = globs.some((g) => matchGlob(target, g) || matchGlob(String(raw), g));
    }
  } else if (cond.anyArg) {
    const needles = [];
    if (cond.contains !== undefined) needles.push(cond.contains);
    if (cond.equals !== undefined) needles.push(cond.equals);
    if (cond.regex !== undefined) needles.push(new RegExp(cond.regex, cond.flags ?? '').source);
    const haystack = collectStrings(args);
    hit = needles.some((needle) => haystack.some((s) => s.includes(needle)));
  } else {
    const raw = args[cond.arg];
    const value = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    if (cond.equals !== undefined) hit = value === cond.equals;
    else if (cond.contains !== undefined) hit = value.includes(cond.contains);
    else if (cond.regex !== undefined) hit = new RegExp(cond.regex, cond.flags ?? '').test(value);
  }

  return cond.not ? !hit : hit;
}

function matchesTool(rule, request) {
  if (rule.tools === undefined) return true;
  const list = Array.isArray(rule.tools) ? rule.tools : [rule.tools];
  return list.some((pattern) => matchGlob(request.tool, pattern) || matchGlob(request.rawTool, pattern));
}

/** True when this rule should stop the tool call. */
export function ruleMatches(rule, request) {
  if (!matchesTool(rule, request)) return false;
  return rule.when.every((cond) => matchesCondition(cond, request));
}

/**
 * Evaluate one tool call against a rule set.
 * First matching rule wins; no match means allow.
 */
export function evaluate(rawRequest, config) {
  const request = normalize(rawRequest);
  for (const rule of config.rules ?? []) {
    if (rule.enabled === false) continue;
    if (!ruleMatches(rule, request)) continue;
    const reason = rule.reason ?? `blocked by guard "${rule.id}"`;
    return {
      action: rule.action ?? 'deny',
      ruleId: rule.id,
      reason: `${rule.id}: ${reason}`,
      harness: request.harness,
      tool: request.rawTool,
      request,
    };
  }
  return { action: 'allow', ruleId: null, reason: null, harness: request.harness, tool: request.rawTool, request };
}