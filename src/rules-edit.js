import fs from 'node:fs';

// Surgical editing of the rules file.
//
// The rules file is JSONC because a guard must be able to say *why* it exists.
// A full parse/stringify round-trip would delete exactly that, so every write
// here is a text edit: find the exact span of one rule and change only that.
// Comments and formatting elsewhere in the file are never touched.

/** Walk `text` once, tracking strings and comments, and report the spans of the
 *  objects inside the `"rules"` array. Brace counting, not regex: a regex cannot
 *  tell a brace inside a string from a brace that structures the document. */
export function scanRules(text) {
  const key = findKey(text, 'rules');
  const colon = key === -1 ? -1 : nextNonSpace(text, key + '"rules"'.length);
  const arrayStart = colon === -1 ? -1 : nextNonSpace(text, colon + 1);
  if (arrayStart === -1 || text[arrayStart] !== '[') return { elements: [], open: -1, close: -1 };

  const elements = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = arrayStart + 1; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end === -1) break; i = end + 1; continue; }
    if (c === '[' || c === '{') { if (depth === 0 && c === '{') start = i; depth++; continue; }
    if (c === ']' || c === '}') {
      if (depth === 0) return { elements, open: arrayStart, close: i };
      depth--;
      if (depth === 0 && c === '}' && start !== -1) { elements.push({ start, end: i + 1 }); start = -1; }
      continue;
    }
  }
  return { elements, open: arrayStart, close: -1 };
}

/** Index of the `"rules"` key, or -1. */
function findKey(text, key) {
  const needle = `"${key}"`;
  let i = text.indexOf(needle);
  while (i !== -1) {
    if (nextNonSpace(text, i + needle.length) !== -1
      && text[nextNonSpace(text, i + needle.length)] === ':') return i;
    i = text.indexOf(needle, i + 1);
  }
  return -1;
}

function nextNonSpace(text, from) {
  let i = from;
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r') { i++; continue; }
    if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? text.length : e + 2; continue; }
    return i;
  }
  return -1;
}

/** The `"id"` string of the rule whose object starts at `start`. */
export function readRuleId(text, start, end) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      // i is the opening quote of the key; `"id"` is three characters wide.
      if (depth === 1 && text.startsWith('"id"', i)) {
        const colon = nextNonSpace(text, i + 4);
        const open = colon === -1 ? -1 : nextNonSpace(text, colon + 1);
        if (open !== -1 && text[open] === '"') {
          let value = '';
          for (let j = open + 1; j < end; j++) {
            if (text[j] === '\\') { value += text[j + 1]; j++; continue; }
            if (text[j] === '"') return value;
            value += text[j];
          }
        }
      }
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return null;
}

/** Every rule in file order: `{ id, enabled, start, end }`. */
export function listRules(text) {
  return scanRules(text).elements.map((span) => {
    const block = text.slice(span.start, span.end);
    return {
      id: readRuleId(text, span.start, span.end),
      enabled: !/"enabled"\s*:\s*false/.test(block),
      ...span,
    };
  });
}

function requireRule(text, id) {
  const rule = listRules(text).find((r) => r.id === id);
  if (!rule) {
    const known = listRules(text).map((r) => r.id).filter(Boolean);
    throw new Error(`regra "${id}" não existe (disponíveis: ${known.join(', ') || 'nenhuma'})`);
  }
  return rule;
}

/** The whitespace that indents the first key of the object starting at `start`. */
function keyIndent(text, start) {
  const firstKey = text.indexOf('\n', start);
  if (firstKey === -1) return '      ';
  const after = text.slice(firstKey + 1);
  return after.match(/^[ \t]*/)[0];
}

/** The leading whitespace of the line that contains `index`. */
function indentAt(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(lineStart, index).match(/^[ \t]*/)[0];
}

/** Re-indent a pretty-printed rule so its `{` lines up with `indent`. */
function align(rule, indent) {
  // JSON.stringify already carries the relative structure; prefixing every line
  // with the neighbour's indentation is all that is needed to line the `{` up.
  return JSON.stringify(rule, null, 2).split('\n').map((line) => indent + line).join('\n');
}

/** Turn a rule on or off by adding or removing `"enabled": false`. */
export function setEnabled(text, id, enabled) {
  const rule = requireRule(text, id);
  if (enabled) {
    // Drop the whole line so formatting stays clean; fall back to a surgical cut
    // if the flag was written inline on a shared line.
    const block = text.slice(rule.start, rule.end);
    const inline = block.match(/[ \t]*"enabled"\s*:\s*false,?[ \t]*\n/);
    if (inline) {
      const cut = rule.start + inline.index;
      return text.slice(0, cut) + text.slice(cut + inline[0].length);
    }
    const tight = block.match(/"enabled"\s*:\s*false\s*,?\s*/);
    if (tight) return text.slice(0, rule.start) + block.replace(tight[0], '') + text.slice(rule.end);
    return text;
  }
  if (!rule.enabled) return text;
  const indent = keyIndent(text, rule.start);
  const insertAt = text.indexOf('\n', rule.start) + 1;
  return `${text.slice(0, insertAt)}${indent}"enabled": false,\n${text.slice(insertAt)}`;
}

/** Delete a rule entirely, taking its comma with it. */
export function removeRule(text, id) {
  const rule = requireRule(text, id);
  let from = rule.start;
  let to = rule.end;

  const after = nextNonSpace(text, to);
  if (after !== -1 && text[after] === ',') to = after + 1;
  else {
    const before = previousNonSpace(text, from);
    if (before !== -1 && text[before] === ',') from = before;
  }
  // Swallow the blank line the rule used to leave behind.
  while (text[to] === '\n' && text[to + 1] === '\n') to++;
  return text.slice(0, from) + text.slice(to);
}

function previousNonSpace(text, from) {
  let i = from - 1;
  while (i >= 0) {
    if (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r') { i--; continue; }
    return i;
  }
  return -1;
}

/** Append a rule, matching the indentation already used by its neighbours. */
export function appendRule(text, rule) {
  const { elements, open, close } = scanRules(text);
  if (elements.length === 0) {
    const indent = indentAt(text, open) + '  ';
    return `${text.slice(0, open + 1)}\n${align(rule, indent)}\n${indentAt(text, open)}` + text.slice(close);
  }
  const last = elements[elements.length - 1];
  return `${text.slice(0, last.end)},\n${align(rule, indentAt(text, last.start))}${text.slice(last.end)}`;
}

/** Read the file, apply `edit`, write it back, and report what changed. */
export function editRulesFile(file, edit) {
  const before = fs.readFileSync(file, 'utf8');
  const after = edit(before);
  if (after === before) return { changed: false, text: before };
  fs.writeFileSync(file, after);
  return { changed: true, text: after };
}