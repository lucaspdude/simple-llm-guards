// pi and omp adapter — in-process.
//
// Both harnesses expose the identical extension API: a default factory receives
// the runtime and subscribes to `tool_call`, whose handler may mutate `event.input`
// or return `{ block: true, reason }`. No subprocess, no JSON on stdout: the
// guard runs inside the agent and blocks the call directly.

import { evaluate } from '../engine.js';
import { defaultConfigPath, loadConfig } from '../rules.js';

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

/**
 * Build the default export that pi/omp load as an extension.
 * `guards install pi` writes a one-line file re-exporting `createExtension()`.
 */
export function createExtension(configFile = defaultConfigPath()) {
  return function guards(pi) {
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