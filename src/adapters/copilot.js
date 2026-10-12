// GitHub Copilot CLI adapter — subprocess hook on `preToolUse`.
//
// Source: https://docs.github.com/en/copilot/reference/hooks-reference
// camelCase stdin: { sessionId, timestamp, cwd, toolName, toolArgs }
// deny: stdout {"permissionDecision":"deny","permissionDecisionReason":"..."}
// A non-zero exit also denies (command preToolUse hooks are fail-closed), so the
// JSON verdict is the only thing we rely on and errors still block.

export const harness = 'copilot';
export const event = 'preToolUse';

export function parse(payload) {
  return {
    tool: payload?.toolName ?? payload?.tool_name,
    args: typeof payload?.toolArgs === 'string' ? safeParse(payload.toolArgs) : payload?.toolArgs ?? payload?.tool_input,
    cwd: payload?.cwd,
    sessionId: payload?.sessionId ?? payload?.session_id,
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function format(decision) {
  if (decision.action !== 'deny') return { stdout: '', exitCode: 0 };
  const body = {
    permissionDecision: 'deny',
    permissionDecisionReason: decision.reason,
  };
  return { stdout: JSON.stringify(body), exitCode: 0 };
}