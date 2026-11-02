import type { AgentEventPayload } from '../events/schema.js';

export type HandoffPattern = 'supervisor' | 'swarm';

/**
 * Observed in the pinned SDKs (not assumed):
 * - langgraph-supervisor 1.1.3 `createHandoffTool` → `transfer_to_<normalized agentName>`,
 *   and `createHandoffBackMessages` → `transfer_back_to_<normalized supervisorName>`.
 * - langgraph-swarm 1.0.4 `createHandoffTool` → `transfer_to_<normalized agentName>`.
 * Both normalise with `trim().replace(/\s+/g, "_").toLowerCase()`, so a worker
 * named "Code Reviewer" produces `transfer_to_code_reviewer`.
 */
export const HANDOFF_TOOL_PREFIX = 'transfer_to_';
export const HANDOFF_BACK_TOOL_PREFIX = 'transfer_back_to_';

export interface HandoffClassification {
  pattern: HandoffPattern;
  to: string;
}

/**
 * `transfer_back_to_*` exists only in the supervisor package, so it is
 * unambiguous. `transfer_to_*` is emitted identically by both packages, hence
 * the optional `pattern` hint: callers that built the graph know which SDK is
 * in play. The default is the hint-free best guess, `"swarm"`.
 */
export function classifyHandoffToolName(
  name: string,
  pattern?: HandoffPattern,
): HandoffClassification | undefined {
  if (name.startsWith(HANDOFF_BACK_TOOL_PREFIX)) {
    const to = rest(name, HANDOFF_BACK_TOOL_PREFIX);
    return to === undefined ? undefined : { pattern: 'supervisor', to };
  }
  if (name.startsWith(HANDOFF_TOOL_PREFIX)) {
    const to = rest(name, HANDOFF_TOOL_PREFIX);
    return to === undefined ? undefined : { pattern: pattern ?? 'swarm', to };
  }
  return undefined;
}

function rest(name: string, prefix: string): string | undefined {
  const to = name.slice(prefix.length);
  return to.length > 0 ? to : undefined;
}

export type SubagentHandoffPayload = AgentEventPayload<'subagent.handoff'>;

/**
 * Maps one handoff tool call onto our `subagent.handoff` payload. Pure: the
 * caller supplies `from` (the agent that emitted the tool call) because neither
 * SDK encodes the source in the tool name.
 */
export function handoffEventInput(
  name: string,
  from: string,
  opts?: { pattern?: HandoffPattern; reason?: string },
): SubagentHandoffPayload | undefined {
  const classified = classifyHandoffToolName(name, opts?.pattern);
  if (classified === undefined) return undefined;
  const reason = opts?.reason;
  return {
    from,
    to: classified.to,
    ...(reason === undefined || reason.length === 0 ? {} : { reason }),
    pattern: classified.pattern,
  };
}
