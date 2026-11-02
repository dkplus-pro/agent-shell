/**
 * Event schema v1 — docs/03-cli-and-trace.md §6. `v` is frozen at 1; any field
 * change requires a version bump plus a migration note (AGENT.md §2).
 */
import { z } from 'zod';
import { newEventId } from '../ids.js';

export const EVENT_SCHEMA_VERSION = 1 as const;

export const EVENT_SOURCES = [
  'runtime',
  'graph',
  'provider',
  'tool',
  'plugin',
  'mcp',
  'subagent',
  'approval',
  'cli',
] as const;
export type AgentEventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_TYPES = [
  'run.started',
  'run.finished',
  'run.error',
  'graph.node.started',
  'graph.node.finished',
  'llm.started',
  'llm.completed',
  'llm.error',
  'tool.started',
  'tool.approval.requested',
  'tool.approval.decided',
  'tool.finished',
  'tool.error',
  'subagent.started',
  'subagent.finished',
  'subagent.handoff',
  'plugin.loaded',
  'plugin.error',
  'mcp.connected',
  'mcp.disconnected',
  'mcp.error',
  'session.started',
  'session.resumed',
  'budget.exceeded',
  'trace.redaction',
  'log',
] as const;
export type AgentEventType = (typeof EVENT_TYPES)[number];

export const RUN_STATUSES = ['ok', 'error', 'cancelled', 'denied'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TOOL_RISKS = ['read', 'write', 'exec'] as const;
export type Risk = (typeof TOOL_RISKS)[number];

export const TOKEN_USAGE_SCHEMA = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  estimated: z.boolean().optional(),
});
export type TokenUsage = z.infer<typeof TOKEN_USAGE_SCHEMA>;

const errorPayload = z.object({
  name: z.string(),
  code: z.string().optional(),
  message: z.string(),
});

const spanFields = {
  v: z.literal(EVENT_SCHEMA_VERSION),
  id: z.string().regex(/^evt_[0-9a-f-]{36}$/),
  ts: z.string(),
  sessionId: z.string().regex(/^ses_/),
  runId: z.string().regex(/^run_/),
  spanId: z.string().regex(/^spn_/),
  parentSpanId: z.string().regex(/^spn_/).optional(),
  source: z.enum(EVENT_SOURCES),
};

const envelopeBase = z.object(spanFields);

/**
 * Per-type payload contracts. Unknown extra keys are rejected so a schema drift
 * fails loudly at trace-read time instead of rendering silently wrong.
 */
export const EVENT_PAYLOAD_SCHEMAS = {
  'run.started': z
    .object({
      inputPreview: z.string(),
      provider: z.string(),
      model: z.string(),
      preset: z.string(),
      resumedFrom: z.string().optional(),
    })
    .strict(),
  'run.finished': z
    .object({
      status: z.enum(RUN_STATUSES),
      durationMs: z.number().nonnegative(),
      usage: TOKEN_USAGE_SCHEMA,
      stepCount: z.number().int().nonnegative(),
      subagentCount: z.number().int().nonnegative(),
    })
    .strict(),
  'run.error': z.object({ error: errorPayload }).strict(),
  'graph.node.started': z
    .object({ node: z.string(), step: z.number().int().nonnegative() })
    .strict(),
  'graph.node.finished': z
    .object({ node: z.string(), durationMs: z.number().nonnegative() })
    .strict(),
  'llm.started': z
    .object({
      provider: z.string(),
      model: z.string(),
      messageCount: z.number().int().nonnegative(),
      toolCount: z.number().int().nonnegative(),
      stream: z.boolean(),
      agent: z.string().optional(),
    })
    .strict(),
  'llm.completed': z
    .object({
      finishReason: z.string(),
      usage: TOKEN_USAGE_SCHEMA,
      durationMs: z.number().nonnegative(),
      firstTokenMs: z.number().nonnegative().optional(),
      outputPreview: z.string(),
      outputTruncated: z.boolean(),
      outputSha256: z.string(),
      toolCallCount: z.number().int().nonnegative().optional(),
      agent: z.string().optional(),
    })
    .strict(),
  'llm.error': z.object({ provider: z.string(), model: z.string(), error: errorPayload }).strict(),
  'tool.started': z
    .object({
      name: z.string(),
      source: z.enum(['code', 'plugin', 'mcp', 'runtime']),
      risk: z.enum(TOOL_RISKS),
      callId: z.string(),
      argsPreview: z.unknown(),
      argsTruncated: z.boolean(),
      agent: z.string().optional(),
    })
    .strict(),
  'tool.approval.requested': z
    .object({
      approvalId: z.string(),
      name: z.string(),
      source: z.enum(['code', 'plugin', 'mcp', 'runtime']),
      risk: z.enum(['write', 'exec']),
      argsPreview: z.unknown(),
      attempt: z.union([z.literal(1), z.literal(2)]),
      target: z.string().optional(),
    })
    .strict(),
  'tool.approval.decided': z
    .object({
      approvalId: z.string(),
      name: z.string(),
      decision: z.enum(['approve', 'deny']),
      actor: z.enum(['user', 'policy', 'script']),
      reason: z.string().optional(),
      confirmation: z.literal('run').optional(),
    })
    .strict(),
  'tool.finished': z
    .object({
      name: z.string(),
      callId: z.string(),
      durationMs: z.number().nonnegative(),
      resultPreview: z.string(),
      truncated: z.boolean(),
      sha256: z.string(),
      isError: z.boolean(),
    })
    .strict(),
  'tool.error': z.object({ name: z.string(), callId: z.string(), error: errorPayload }).strict(),
  'subagent.started': z
    .object({
      pattern: z.enum(['spawn', 'supervisor', 'swarm']),
      name: z.string(),
      depth: z.number().int().nonnegative(),
      taskPreview: z.string(),
    })
    .strict(),
  'subagent.finished': z
    .object({
      pattern: z.enum(['spawn', 'supervisor', 'swarm']),
      name: z.string(),
      status: z.enum(RUN_STATUSES),
      durationMs: z.number().nonnegative(),
      usage: TOKEN_USAGE_SCHEMA,
    })
    .strict(),
  'subagent.handoff': z
    .object({
      from: z.string(),
      to: z.string(),
      reason: z.string().optional(),
      pattern: z.enum(['supervisor', 'swarm']).optional(),
    })
    .strict(),
  'plugin.loaded': z
    .object({
      name: z.string(),
      version: z.string(),
      apiVersion: z.string(),
      tools: z.array(z.string()),
    })
    .strict(),
  'plugin.error': z.object({ name: z.string(), path: z.string(), error: errorPayload }).strict(),
  'mcp.connected': z
    .object({
      server: z.string(),
      transport: z.enum(['stdio', 'http']),
      toolCount: z.number().int().nonnegative(),
    })
    .strict(),
  'mcp.disconnected': z.object({ server: z.string(), reason: z.string().optional() }).strict(),
  'mcp.error': z.object({ server: z.string(), error: errorPayload }).strict(),
  'session.started': z.object({ sessionId: z.string(), threadId: z.string() }).strict(),
  'session.resumed': z
    .object({ sessionId: z.string(), threadId: z.string(), checkpointId: z.string().optional() })
    .strict(),
  'budget.exceeded': z
    .object({
      kind: z.enum(['steps', 'tokens', 'time', 'subagents', 'depth']),
      limit: z.number(),
      used: z.number(),
      agent: z.string().optional(),
    })
    .strict(),
  'trace.redaction': z.object({ fieldsRedacted: z.number().int().nonnegative() }).strict(),
  log: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error']),
      message: z.string(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
} satisfies Record<AgentEventType, z.ZodType>;

export type AgentEventPayload<T extends AgentEventType = AgentEventType> = z.infer<
  (typeof EVENT_PAYLOAD_SCHEMAS)[T]
>;

export type AgentEventOf<T extends AgentEventType> =
  z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]> extends infer P
    ? Omit<z.infer<typeof envelopeBase>, 'payload'> & { type: T; payload: P }
    : never;

export type AnyAgentEventEnvelope = z.infer<typeof envelopeBase> & {
  type: AgentEventType;
  payload: Record<string, unknown>;
};

const looseEvent = envelopeBase.extend({
  type: z.enum(EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
});

export const agentEventSchema = looseEvent;

export function validateEvent(value: unknown): AgentEvent {
  const envelope = looseEvent.parse(value);
  const payloadSchema = EVENT_PAYLOAD_SCHEMAS[envelope.type];
  const parsed = payloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Event ${envelope.type} payload violates schema v1 — ${issues}`);
  }
  return envelope as AgentEvent;
}

export type AgentEvent = AnyAgentEventEnvelope;

export type NewEvent<T extends AgentEventType> = {
  type: T;
  sessionId: string;
  runId: string;
  spanId: string;
  parentSpanId?: string;
  source: AgentEventSource;
  payload: Record<string, unknown>;
  ts?: string;
  id?: string;
};

export function makeEvent<T extends AgentEventType>(input: NewEvent<T>): AgentEvent {
  const event: AgentEvent = {
    v: EVENT_SCHEMA_VERSION,
    id: input.id ?? newEventId(),
    ts: input.ts ?? new Date().toISOString(),
    sessionId: input.sessionId,
    runId: input.runId,
    spanId: input.spanId,
    ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
    type: input.type,
    source: input.source,
    payload: input.payload,
  };
  return event;
}

export function parseEventLine(line: string): AgentEvent | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return validateEvent(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}
