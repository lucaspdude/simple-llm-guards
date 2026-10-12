// Claude Code adapter — subprocess hook on `PreToolUse`.
//
// Source: https://code.claude.com/docs/en/hooks
// stdin  { tool_name, tool_input, cwd, session_id }
// deny   stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                "permissionDecision":"deny","permissionDecisionReason":"..."}}
//       + exit 0. Exit 2 with the reason on stderr is the older, equivalent form.

export const harness = 'claude';
export const event = 'PreToolUse';

export function parse(payload) {
  return {
    tool: payload?.tool_name ?? payload?.toolName,
    args: payload?.tool_input ?? payload?.toolArgs ?? payload?.toolArgsParsed,
    cwd: payload?.cwd,
    sessionId: payload?.session_id ?? payload?.sessionId,
  };
}

export function format(decision) {
  if (decision.action !== 'deny') return { stdout: '', exitCode: 0 };
  const body = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
  return { stdout: JSON.stringify(body), exitCode: 0 };
}