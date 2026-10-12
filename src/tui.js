// The standalone `guards manage` menu: a full-screen list you drive with the
// keyboard. No dependencies — raw mode plus a handful of ANSI escapes is the
// whole renderer, and the renderer only has to redraw when state changes.

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

const HELP = '↑↓ move · espaço liga/desliga · n nova · d apaga · q sai';

/** Run the menu until the user quits. */
export async function runManage(file) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
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

  // Raw mode for the list, plain readline for the wizard: a form needs typing,
  // and typing needs line editing. Mixing the two is less code than a text field.
  const enterRaw = () => new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('readable', resolve);
  });
  const leaveRaw = () => new Promise((resolve) => {
    stdin.off('readable', resolve);
    stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write(`${ESC}?25h`);
    resolve();
  });
  const showCursor = () => process.stdout.write(`${ESC}?25h`);

  const ask = (question) => new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
  });

  const wizard = async () => {
    await leaveRaw();
    process.stdout.write(CLEAR);
    console.log('\nNova guarda\n');
    const choices = TEMPLATES.map((t, i) => `  ${i + 1}) ${t.label}  ${DIM}${t.hint}${RESET}`).join('\n');
    console.log(choices + '\n');
    const pick = await ask('tipo (1-4): ');
    const template = TEMPLATES[Number(pick) - 1] ?? TEMPLATES[0];
    const value = template.key === 'custom'
      ? await ask('regra em JSON (quando um comando é bloqueado, insira {"tools":["shell"],"when":[{"arg":"command","regex":"..."}]}): ')
      : await ask(`padrão/texto para bloquear: `);
    const reason = await ask('motivo (vai para o agente): ');
    let rule;
    try {
      rule = buildRule({ templateKey: template.key, value, reason, templateText: value });
    } catch (e) {
      await ask(`\n✗ ${e.message}\nenter para voltar`);
      return null;
    }
    await ask(`\ncria "${rule.id}"? (enter para confirmar, "n" cancela) `);
    return rule;
  };

  refresh();
  await enterRaw();

  for (;;) {
    const chunk = stdin.read();
    if (chunk === null) break;
    for (const key of String(chunk)) {
      const current = state.rules[cursor];
      if (key === 'q' || key === '\x03') {
        await leaveRaw();
        process.stdout.write(CLEAR + 'guards\n');
        return 0;
      }
      if (key === '\x1b') continue; // ignore the rest of an arrow sequence
      if (key === 'A' || key === 'k') { cursor = (cursor - 1 + state.rules.length) % Math.max(1, state.rules.length); draw(); continue; }
      if (key === 'B' || key === 'j') { cursor = (cursor + 1) % Math.max(1, state.rules.length); draw(); continue; }
      if (key === ' ' || key === '\r' || key === '\n') {
        if (!current) continue;
        try { toggle(file, current.id); refresh(`${current.id} agora está ${!current.enabled ? 'ligada' : 'desligada'}`); }
        catch (e) { refresh(e.message); }
        continue;
      }
      if (key === 'd') {
        if (!current) continue;
        try { remove(file, current.id); refresh(`${current.id} removida`); }
        catch (e) { refresh(e.message); }
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
        continue;
      }
    }
  }
  await leaveRaw();
  showCursor();
  return 0;
}