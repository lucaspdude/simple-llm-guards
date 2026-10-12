import fs from 'node:fs';
import path from 'node:path';
import { appendRule, listRules, removeRule, setEnabled } from './rules-edit.js';
import { parseConfig } from './rules.js';
import { STARTER_RULES } from './starter.js';

/**
 * The shared menu core.
 *
 * Both surfaces — the standalone `guards manage` terminal and `/guards manage`
 * inside pi/omp — call these functions. Neither one owns any state of its own,
 * which is why the menu cannot drift between terminals.
 */

export function ensureFile(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, STARTER_RULES);
  }
  return file;
}

/** Current rules, in file order, with the state the menu needs. */
export function snapshot(file) {
  ensureFile(file);
  const text = fs.readFileSync(file, 'utf8');
  const spans = listRules(text);
  let parsed;
  try {
    parsed = parseConfig(text, file);
  } catch (e) {
    // A broken file must not make the menu unusable; show the error, edit nothing.
    return { text, rules: spans, error: e.message };
  }
  const rules = spans.map((span) => {
    const rule = parsed.rules.find((r) => r.id === span.id);
    return { ...span, enabled: span.enabled, rule, tools: rule?.tools ?? [] };
  });
  return { text, rules, error: null };
}

export function toggle(file, id) {
  const before = snapshot(file);
  const rule = before.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`regra "${id}" não existe`);
  const next = rule.enabled ? false : true;
  fs.writeFileSync(file, setEnabled(before.text, id, next));
  return { id, enabled: next };
}

export function remove(file, id) {
  const before = snapshot(file);
  fs.writeFileSync(file, removeRule(before.text, id));
  return { id };
}

export function add(file, rule) {
  const before = snapshot(file);
  if (before.rules.some((r) => r.id === rule.id)) throw new Error(`regra "${rule.id}" já existe`);
  // Validate before touching the file: a half-written rule is worse than none.
  const probe = appendRule(before.text, rule);
  parseConfig(probe, file);
  fs.writeFileSync(file, probe);
  return { id: rule.id };
}

/** One-line description used by both menus. */
export function describeRule(rule) {
  const tools = rule.tools?.length ? rule.tools.join(', ') : 'qualquer ferramenta';
  return `${tools} — ${summariseWhen(rule.when)}`;
}

function summariseWhen(when) {
  const parts = [];
  for (const cond of when ?? []) {
    if (Array.isArray(cond.anyOf)) {
      parts.push(`ou: ${cond.anyOf.map(summariseCondition).join(' / ')}`);
      continue;
    }
    parts.push(summariseCondition(cond));
  }
  return parts.join(' e ') || 'sempre';
}

function summariseCondition(cond) {
  if (cond.glob) return `arquivo ${[].concat(cond.glob).join(', ')}`;
  if (cond.anyArg) return `qualquer argumento contém "${cond.contains ?? cond.equals}"`;
  const arg = cond.arg ?? 'argumento';
  if (cond.regex) return `${arg} =~ /${cond.regex}/`;
  if (cond.contains) return `${arg} contém "${cond.contains}"`;
  if (cond.equals) return `${arg} == "${cond.equals}"`;
  return JSON.stringify(cond);
}

/** Templates offered by the "new guard" wizard. */
export const TEMPLATES = [
  {
    key: 'command',
    label: 'bloquear um comando',
    hint: 'ex: rm -rf /, git push --force, npm publish',
    build: (value) => ({
      tools: ['shell'],
      when: [{ arg: 'command', regex: value }],
      reason: `comando bloqueado: ${value}`,
    }),
  },
  {
    key: 'path',
    label: 'bloquear um arquivo',
    hint: 'ex: **/.env, **/.ssh/**, *.pem',
    build: (value) => ({
      tools: ['read', 'write', 'edit', 'shell'],
      when: [{ arg: 'file_path', glob: [value] }],
      reason: `arquivo bloqueado: ${value}`,
    }),
  },
  {
    key: 'text',
    label: 'bloquear um texto em qualquer argumento',
    hint: 'ex: uma chave de API vazando no comando',
    build: (value) => ({
      when: [{ anyArg: true, contains: value }],
      reason: `texto bloqueado em qualquer argumento: ${value}`,
    }),
  },
  {
    key: 'custom',
    label: 'escrever a regra na mão',
    hint: 'você digita o JSON inteiro',
    build: (value) => JSON.parse(value),
  },
];

/** Turn wizard answers into a validated rule. */
export function buildRule({ id, templateKey, value, reason, templateText }) {
  const template = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0];
  const built = templateKey === 'custom'
    ? JSON.parse(templateText ?? '{}')
    : template.build(value);
  const rule = {
    id: slugify(id) || `guard-${Date.now().toString(36)}`,
    action: built.action ?? 'deny',
    ...(built.tools ? { tools: built.tools } : {}),
    when: built.when,
    reason: reason || built.reason,
  };
  parseConfig(JSON.stringify({ rules: [rule] }), '<wizard>');
  return rule;
}

/** `No Force Push!` -> `no-force-push` */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}