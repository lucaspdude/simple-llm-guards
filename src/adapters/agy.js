// Antigravity CLI (`agy`) adapter — subprocess hook on `PreToolUse`.
//
// Source: https://antigravity.google/docs/hooks/
// stdin  { toolCall: { name, args }, workspacePaths, conversationId, stepIdx }
//        Field names are camelCase and the tool call is nested one level deeper
//        than in every other harness — the reason this adapter exists at all.
// deny   stdout {"decision":"deny","reason":"..."}

export const harness = 'agy';
export const event = 'PreToolUse';

export function parse(payload) {
  const call = payload?.toolCall ?? payload?.tool_call ?? {};
  return {
    tool: call.name ?? payload?.tool_name ?? payload?.toolName,
    args: call.args ?? call.input ?? payload?.tool_input,
    cwd: (Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : undefined) ?? payload?.cwd,
    sessionId: payload?.conversationId ?? payload?.conversation_id,
  };
}

export function format(decision) {
  if (decision.action !== 'deny') return { stdout: '', exitCode: 0 };
  return {
    stdout: JSON.stringify({ decision: 'deny', reason: decision.reason }),
    exitCode: 0,
  };
}