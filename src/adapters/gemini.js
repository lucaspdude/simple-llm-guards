// Gemini CLI adapter — subprocess hook on `BeforeTool`.
//
// Source: https://geminicli.com/docs/hooks/reference/
// stdin  { tool_name, tool_input, cwd, session_id, hook_event_name }
// deny   stdout {"decision":"deny","reason":"..."} (exit 0). Exit 2 with the
//        reason on stderr is the equivalent system-block form.

export const harness = 'gemini';
export const event = 'BeforeTool';

export function parse(payload) {
  return {
    tool: payload?.tool_name ?? payload?.toolName,
    args: payload?.tool_input ?? payload?.toolArgs,
    cwd: payload?.cwd,
    sessionId: payload?.session_id ?? payload?.sessionId,
  };
}

export function format(decision) {
  if (decision.action !== 'deny') return { stdout: '', exitCode: 0 };
  return {
    stdout: JSON.stringify({ decision: 'deny', reason: decision.reason }),
    exitCode: 0,
  };
}