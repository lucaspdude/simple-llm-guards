// pi and omp adapter — in-process.
//
// Both harnesses expose the identical extension API: a default factory receives
// the runtime and subscribes to `tool_call`, whose handler may mutate `event.input`
// or return `{ block: true, reason }`. No subprocess, no JSON on stdout: the
// guard runs inside the agent and blocks the call directly.

import { evaluate } from '../engine.js';
import { defaultConfigPath, loadConfig } from '../rules.js';
import { add, buildRule, describeRule, remove, snapshot, toggle, TEMPLATES } from '../manage.js';

export const harness = 'pi';
export const event = 'tool_call';

export function parse(payload) {
  return {
    tool: payload?.toolName ?? payload?.tool_name,
    args: payload?.input ?? payload?.tool_input,
    cwd: payload?.cwd,
    sessionId: payload?.sessionId ?? payload?.session_id,
  };
}

/** The native block shape: returning this object stops the tool call. */
export function format(decision) {
  if (decision.action === 'deny') return { block: true, reason: decision.reason };
  return undefined;
}

const MENU_NEW = '＋ criar nova guarda';

/**
 * The in-harness menu behind `/guards manage`.
 *
 * pi owns the terminal, so this uses the built-in dialogs — pi's own TUI guide
 * says to reach for `ctx.ui.select()` before writing a custom component. Same
 * actions as the standalone `guards manage`; only the rendering differs.
 */
async function openMenu(ctx, configFile) {
  const ui = ctx.ui;
  for (;;) {
    const state = snapshot(configFile);
    if (state.error) {
      await ui.notify(`guards: ${state.error}`, 'error');
      return;
    }
    const options = state.rules.length
      ? state.rules.map((rule) => {
          const mark = rule.enabled ? '● on' : '○ off';
          return `${mark}  ${rule.id} — ${describeRule(rule.rule ?? { when: [] })}`;
        })
      : ['(nenhuma guarda ainda)'];
    options.push(MENU_NEW);

    const choice = await ui.select(`guardas — ${configFile}`, options);
    if (!choice) return; // Esc / cancel closes the menu
    if (choice === MENU_NEW) {
      await newGuardWizard(ctx, configFile);
      continue;
    }

    const index = options.indexOf(choice);
    const rule = state.rules[index];
    if (!rule) continue;

    const action = await ui.select(rule.id, [
      rule.enabled ? 'desligar' : 'ligar',
      'remover',
      'voltar',
    ]);
    if (!action || action === 'voltar') continue;
    try {
      if (action === 'remover') {
        if (!(await ui.confirm(rule.id, 'apagar esta guarda do arquivo?'))) continue;
        remove(configFile, rule.id);
        await ui.notify(`${rule.id} removida`, 'info');
      } else {
        toggle(configFile, rule.id);
        await ui.notify(`${rule.id} agora está ${rule.enabled ? 'desligada' : 'ligada'}`, 'info');
      }
    } catch (e) {
      await ui.notify(e.message, 'error');
    }
  }
}

/** Four questions, one rule. Same templates as the standalone menu. */
async function newGuardWizard(ctx, configFile) {
  const ui = ctx.ui;
  const label = await ui.select('que tipo de guarda?', TEMPLATES.map((t) => t.label));
  if (!label) return;
  const template = TEMPLATES.find((t) => t.label === label);
  const value = await ui.input(template.hint, template.key === 'custom' ? '{"tools":[…],"when":[…]}' : '');
  if (!value) return;
  const reason = await ui.input('motivo — é isso que o agente vai ler', '');
  try {
    const rule = buildRule({
      id: template.label,
      templateKey: template.key,
      value,
      reason,
      templateText: value,
    });
    add(configFile, rule);
    await ui.notify(`${rule.id} criada`, 'info');
  } catch (e) {
    await ui.notify(e.message, 'error');
  }
}

/**
 * Build the default export that pi/omp load as an extension.
 * `guards install pi` writes a one-line file re-exporting `createExtension()`.
 */
export function createExtension(configFile = defaultConfigPath()) {
  return function guards(pi) {
    pi.registerCommand?.('guards', {
      description: 'abrir o menu das guardas (guards manage)',
      handler: async (args, ctx) => {
        if (!ctx.hasUI) {
          ctx.ui?.notify?.('sem interface aqui — rode guards manage num terminal', 'warning');
          return;
        }
        if (args && !/^manage\b/.test(args.trim())) {
          ctx.ui.notify('uso: /guards manage', 'info');
          return;
        }
        await openMenu(ctx, configFile);
      },
    });

    pi.on('tool_call', (event) => {
      let config;
      try {
        config = loadConfig(configFile);
      } catch (e) {
        if (pi.__guardsFailOpen) return undefined;
        return { block: true, reason: `guards: cannot load rules — ${e.message}` };
      }
      return format(evaluate({ harness, cwd: process.cwd(), ...parse(event) }, config));
    });
  };
}