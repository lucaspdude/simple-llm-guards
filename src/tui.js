// Terminal menus: the `guards manage` list and the install checkbox.
//
// No dependencies — raw mode plus a few ANSI escapes is the whole renderer, and
// it only has to redraw when state changes.

import readline from 'node:readline';
import process from 'node:process';
import { add, describeRule, buildRule, remove, snapshot, toggle, TEMPLATES } from './manage.js';

const ESC = '\x1b[';
const CLEAR = `${ESC}2J${ESC}H`;
const INVERSE = '\x1b[7m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// --- terminal plumbing ------------------------------------------------------

const enterRaw = () => new Promise((resolve) => {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.once('readable', resolve);
});

const leaveRaw = () => new Promise((resolve) => {
  process.stdin.off('readable', resolve);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write(`${ESC}?25h`);
  resolve();
});

/** A form needs typing, and typing needs line editing — leave raw mode for it. */
const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
});

/**
 * Split a raw stdin chunk into key tokens.
 *
 * Escape sequences must be consumed as a unit: an arrow key arrives as the three
 * bytes ESC [ A, and treating the ESC on its own as "cancel" would make every
 * arrow key quit the menu.
 */
export function parseKeys(chunk) {
  const keys = [];
  const text = String(chunk);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\x1b') {
      const seq = text.slice(i, i + 3);
      if (seq === '\x1b[A') { keys.push('up'); i += 2; continue; }
      if (seq === '\x1b[B') { keys.push('down'); i += 2; continue; }
      if (seq === '\x1b[C') { keys.push('right'); i += 2; continue; }
      if (seq === '\x1b[D') { keys.push('left'); i += 2; continue; }
      keys.push('cancel');
      continue;
    }
    if (c === '\r' || c === '\n') { keys.push('confirm'); continue; }
    if (c === '\x03') { keys.push('cancel'); continue; }
    keys.push(c);
  }
  return keys;
}

/**
 * Drive a list with the keyboard. `onKey(key, index) -> 'redraw' | 'quit'` owns
 * the behaviour; this owns the screen and the key decoding.
 */
async function keyLoop({ items, render, onKey, onConfirm, onQuit }) {
  let index = 0;
  await enterRaw();
  process.stdout.write(CLEAR);
  for (;;) {
    render(index);
    const chunk = process.stdin.read();
    if (chunk === null) break;
    for (const key of parseKeys(chunk)) {
      if (key === 'up' || key === 'k') { index = (index - 1 + items.length) % Math.max(1, items.length); continue; }
      if (key === 'down' || key === 'j') { index = (index + 1) % Math.max(1, items.length); continue; }
      if (key === 'cancel' || key === 'q') {
        await leaveRaw();
        return onQuit ? onQuit(index) : null;
      }
      if (key === 'confirm') {
        await leaveRaw();
        return onConfirm ? onConfirm(index) : null;
      }
      if (onKey(key, index, false) === 'quit') { await leaveRaw(); return null; }
    }
  }
  await leaveRaw();
  return null;
}

// --- install checkbox -------------------------------------------------------

/**
 * Pre-check every detected harness and let the user turn things off.
 * Returns the chosen ids, or null when the user quits.
 */
export async function selectHarnesses(found, { title = 'instalar o motor de guardas em quais harness?' } = {}) {
  const picked = new Set(found.filter((f) => f.present).map((f) => f.harness));
  let cursor = 0;

  const draw = () => {
    const lines = [YELLOW + title + RESET, ''];
    for (const [i, item] of found.entries()) {
      const box = picked.has(item.harness) ? `${GREEN}[x]${RESET}` : '[ ]';
      const name = item.harness.padEnd(8);
      const mark = item.present
        ? `${DIM}${item.via === 'binario' ? item.binary : item.configDir}${RESET}`
        : `${DIM}não encontrado${RESET}`;
      lines.push(`${i === cursor ? INVERSE : ''}${box} ${name} ${item.label.padEnd(18)} ${mark}${i === cursor ? RESET : ''}`);
    }
    lines.push(
      '',
      `${DIM}↑↓ move · espaço marca · a todas · i inverte · enter instala · q cancela${RESET}`,
    );
    process.stdout.write(CLEAR + lines.join('\n'));
  };

  return keyLoop({
    items: found,
    render: (index) => { cursor = index; draw(); },
    onKey: (key, index) => {
      const item = found[index];
      if (key === ' ') {
        if (picked.has(item.harness)) picked.delete(item.harness);
        else picked.add(item.harness);
        draw();
        return 'redraw';
      }
      return undefined;
      if (key === 'a') { for (const f of found) picked.add(f.harness); draw(); return 'redraw'; }
      if (key === 'n') { picked.clear(); draw(); return 'redraw'; }
      if (key === 'i') {
        for (const f of found) { if (picked.has(f.harness)) picked.delete(f.harness); else picked.add(f.harness); }
        draw();
        return 'redraw';
      }
      return undefined;
    },
    // On confirm, hand back what is currently ticked — not what onKey returned.
    onConfirm: () => [...picked],
    onQuit: () => null,
  });
}

// --- the guard menu ---------------------------------------------------------

const HELP = '↑↓ move · espaço liga/desliga · n nova · d apaga · q sai';

/** Run the guard menu until the user quits. */
export async function runManage(file) {
  if (!process.stdin.isTTY) {
    // No terminal (CI, a pipe): fall back to a plain list so the command still
    // does something useful instead of throwing.
    for (const rule of snapshot(file).rules) {
      console.log(`${rule.enabled ? 'on ' : 'off'}  ${rule.id}  ${describeRule(rule.rule ?? { when: [] })}`);
    }
    return 0;
  }

  let state = snapshot(file);
  let cursor = 0;
  let message = '';

  const draw = () => {
    const lines = [`${YELLOW}guards${RESET} ${DIM}${file}${RESET}`, ''];
    if (state.error) {
      lines.push(`${RED}✗ ${state.error}${RESET}`);
      lines.push(`${DIM}corrija o arquivo e abra o menu de novo${RESET}`);
    } else if (!state.rules.length) {
      lines.push(`${DIM}nenhuma guarda ainda — aperte n para criar a primeira${RESET}`);
    } else {
      for (const [i, rule] of state.rules.entries()) {
        const mark = rule.enabled ? `${GREEN}● on${RESET}` : `${DIM}○ off${RESET}`;
        const pointer = i === cursor ? INVERSE : '';
        const label = `${mark}  ${rule.id.padEnd(24)} ${DIM}${describeRule(rule.rule ?? { when: [] })}${RESET}`;
        lines.push(`${pointer}${label}${pointer ? RESET : ''}`);
      }
    }
    lines.push('', message ? `${YELLOW}${message}${RESET}` : '', `${DIM}${HELP}${RESET}`);
    process.stdout.write(CLEAR + lines.join('\n'));
  };

  const refresh = (note = '') => {
    state = snapshot(file);
    message = note;
    if (cursor >= state.rules.length) cursor = Math.max(0, state.rules.length - 1);
    draw();
  };

  const wizard = async () => {
    await leaveRaw();
    process.stdout.write(CLEAR);
    console.log('\nNova guarda\n');
    console.log(TEMPLATES.map((t, i) => `  ${i + 1}) ${t.label}  ${DIM}${t.hint}${RESET}`).join('\n') + '\n');
    const pick = await ask('tipo (1-4): ');
    const template = TEMPLATES[Number(pick) - 1] ?? TEMPLATES[0];
    const value = template.key === 'custom'
      ? await ask('regra em JSON (quando bloquear: {"tools":["shell"],"when":[{"arg":"command","regex":"..."}]}): ')
      : await ask('padrão/texto para bloquear: ');
    const reason = await ask('motivo (vai para o agente): ');
    let rule;
    try {
      rule = buildRule({ templateKey: template.key, value, reason, templateText: value });
    } catch (e) {
      await ask(`\n✗ ${e.message}\nenter para voltar`);
      return null;
    }
    const confirm = await ask(`\ncria "${rule.id}"? (enter confirma, "n" cancela) `);
    return /^n/i.test(confirm) ? null : rule;
  };

  await new Promise((resolve) => {
    (async () => {
      refresh();
      await enterRaw();
      for (;;) {
        const chunk = process.stdin.read();
        if (chunk === null) break;
        let redo = false;
        for (const key of parseKeys(chunk)) {
          const current = state.rules[cursor];
          if (key === 'cancel' || key === 'q') { await leaveRaw(); process.stdout.write(CLEAR + 'guards\n'); return resolve(); }
          if (key === 'up' || key === 'k') { cursor = (cursor - 1 + state.rules.length) % Math.max(1, state.rules.length); redo = true; continue; }
          if (key === 'down' || key === 'j') { cursor = (cursor + 1) % Math.max(1, state.rules.length); redo = true; continue; }
          if (key === ' ' || key === 'confirm') {
            if (current) {
              try { toggle(file, current.id); refresh(`${current.id} agora está ${current.enabled ? 'desligada' : 'ligada'}`); }
              catch (e) { refresh(e.message); }
            }
            redo = true;
            continue;
          }
          if (key === 'd') {
            if (current) {
              try { remove(file, current.id); refresh(`${current.id} removida`); }
              catch (e) { refresh(e.message); }
            }
            redo = true;
            continue;
          }
          if (key === 'n') {
            await leaveRaw();
            const rule = await wizard();
            if (rule) {
              try { add(file, rule); refresh(`${rule.id} criada`); }
              catch (e) { refresh(e.message); }
            } else refresh('');
            await enterRaw();
            redo = true;
            continue;
          }
        }
        if (redo) draw();
      }
      await leaveRaw();
      resolve();
    })();
  });
  return 0;
}