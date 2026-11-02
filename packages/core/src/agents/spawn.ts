import { z } from 'zod';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AgentEventPayload, AgentEventType, TokenUsage } from '../events/schema.js';
import { BudgetExceededError, CancelledError, SubagentError } from '../errors/index.js';
import type { Limits } from '../limits.js';
import { runtimeToolName } from '../tools/naming.js';
import type { ToolContext, ToolDefinition, ToolOutput } from '../tools/types.js';
import type { LeafAgentSpec } from './react.js';

export const SPAWN_TOOL_NAME = runtimeToolName('spawn_subagent');

export interface SpawnRequest {
  name: string;
  task: string;
  context?: string;
  tools: string[];
  depth: number;
  signal: AbortSignal;
}

export interface SpawnResult {
  output: string;
  usage: TokenUsage;
}

export interface SpawnEventInput {
  type: AgentEventType;
  payload: Record<string, unknown>;
  parentSpanId?: string;
  spanHint?: string;
}

export interface SpawnDeps {
  parentDepth: number;
  limits: Limits;
  usage: { subagents: number; tokens: number };
  agents: Record<string, LeafAgentSpec>;
  /** Resolves the child tool request against the parent's *granted* tool names. */
  registry: { subset(names: string[]): { names: string[] } };
  maxSubagents: number;
  onEvent: (event: SpawnEventInput) => void;
  signal: AbortSignal;
  runSubagent: (input: SpawnRequest) => Promise<SpawnResult>;
}

type SpawnArgs = { task: string; agent: string; context: string };

const spawnArgsSchema = z.object({
  task: z.string().min(1).describe('Self-contained instruction for the subagent.'),
  agent: z.string().min(1).describe('Name of the configured agent to run.'),
  // `.default("")` keeps the field optional for the model while giving execute a
  // total type: ToolJson has no `undefined`, so an optional prop would not type.
  context: z
    .string()
    .optional()
    .default('')
    .describe('Optional excerpt of prior work to hand over.'),
});

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function createSpawnToolDefinition(deps: SpawnDeps): ToolDefinition<SpawnArgs, ToolOutput> {
  return {
    name: SPAWN_TOOL_NAME,
    description:
      'Spawn one configured subagent for a self-contained task. It runs with its own message history and a ' +
      'subset of your tools, and only its final answer is returned.',
    schema: spawnArgsSchema,
    // Spawning delegates to another agent: it touches no file, shell, or network
    // itself, so this tool is read-risk. The child's own tools carry their own
    // risk declarations and go through the parent's approval pipeline.
    risk: 'read',
    // The child gets the run's remaining wall time rather than the 30s tool default.
    timeoutMs: deps.limits.maxWallTimeMs,
    idempotent: false,
    execute: (args, ctx) => executeSpawn(deps, args, ctx),
  };
}

async function executeSpawn(deps: SpawnDeps, args: SpawnArgs, ctx: ToolContext): Promise<string> {
  const depth = deps.parentDepth + 1;
  const parentSpanId = ctx.spanId;

  enforceDepthBudget(deps, args.agent, depth, parentSpanId);
  enforceCountBudget(deps, args.agent, parentSpanId);
  enforceTokenBudget(deps, args.agent, parentSpanId);
  const agent = resolveAgent(deps, args.agent);
  const tools = enforceToolSubset(deps, agent);

  const signal = AbortSignal.any([deps.signal, ctx.signal]);
  if (signal.aborted) {
    // Checked before `subagent.started` so the trace never holds a started
    // subagent that was never finished.
    throw new CancelledError('Run cancelled before subagent start');
  }

  emit(deps, parentSpanId, 'subagent.started', {
    pattern: 'spawn',
    name: agent.name,
    depth,
    taskPreview: preview(args.task),
  } satisfies AgentEventPayload<'subagent.started'>);

  const started = Date.now();
  try {
    const result = await raceAbort(
      deps.runSubagent({
        name: agent.name,
        task: args.task,
        ...(args.context.length > 0 ? { context: args.context } : {}),
        tools,
        depth,
        signal,
      }),
      signal,
      agent.name,
    );
    emitFinished(deps, parentSpanId, agent.name, 'ok', started, result.usage);
    return result.output;
  } catch (error) {
    if (error instanceof CancelledError) {
      emitFinished(deps, parentSpanId, agent.name, 'cancelled', started, EMPTY_USAGE);
      throw error;
    }
    emitFinished(deps, parentSpanId, agent.name, 'error', started, EMPTY_USAGE);
    // A failing child is reported to the parent as text, never as a crash: the
    // parent LLM can re-plan instead of losing the whole run.
    return `subagent failed: ${errorMessage(error)}`;
  }
}

function enforceDepthBudget(
  deps: SpawnDeps,
  agent: string,
  depth: number,
  parentSpanId: string,
): void {
  if (depth <= deps.limits.maxSubagentDepth) return;
  emitBudget(deps, parentSpanId, agent, 'depth', deps.limits.maxSubagentDepth, depth);
  throw new SubagentError(
    `Cannot spawn "${agent}": budget (depth) exceeded — used ${depth} of ${deps.limits.maxSubagentDepth}.`,
    new BudgetExceededError('depth', deps.limits.maxSubagentDepth, depth),
  );
}

function enforceCountBudget(deps: SpawnDeps, agent: string, parentSpanId: string): void {
  const used = deps.usage.subagents + 1;
  const limit = Math.min(deps.limits.maxSubagents, deps.maxSubagents);
  if (used <= limit) return;
  emitBudget(deps, parentSpanId, agent, 'subagents', limit, used);
  throw new SubagentError(
    `Cannot spawn "${agent}": budget (subagents) exceeded — used ${used} of ${limit}.`,
    new BudgetExceededError('subagents', limit, used),
  );
}

function enforceTokenBudget(deps: SpawnDeps, agent: string, parentSpanId: string): void {
  const used = deps.usage.tokens;
  if (used < deps.limits.tokenBudget) return;
  emitBudget(deps, parentSpanId, agent, 'tokens', deps.limits.tokenBudget, used);
  throw new SubagentError(
    `Cannot spawn "${agent}": budget (tokens) exceeded — used ${used} of ${deps.limits.tokenBudget}.`,
    new BudgetExceededError('tokens', deps.limits.tokenBudget, used),
  );
}

function resolveAgent(deps: SpawnDeps, name: string): LeafAgentSpec {
  const agent = deps.agents[name];
  if (agent === undefined) {
    throw new SubagentError(`Unknown subagent "${name}". Available agents: ${available(deps)}.`);
  }
  return agent;
}

function available(deps: SpawnDeps): string {
  const names = Object.keys(deps.agents);
  return names.length > 0 ? names.join(', ') : '(none configured)';
}

/**
 * docs/01-architecture.md §5.6: the child's tool set must be a subset of the
 * parent's, so a child can never gain a tool its parent was not granted.
 */
function enforceToolSubset(deps: SpawnDeps, agent: LeafAgentSpec): string[] {
  const requested = agent.tools.map((tool: StructuredToolInterface) => tool.name);
  const allowed = new Set(deps.registry.subset(requested).names);
  const rejected = requested.filter((tool) => !allowed.has(tool));
  if (rejected.length > 0) {
    throw new SubagentError(
      `Cannot spawn "${agent.name}": its tools ${JSON.stringify(rejected)} are not a subset of the parent's tool set.`,
    );
  }
  return requested;
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  agentName: string,
): Promise<T> {
  if (signal.aborted) throw new CancelledError(`Run cancelled while spawning ${agentName}`);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new CancelledError(`Run cancelled while spawning ${agentName}`));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
        else reject(error);
      },
    );
  });
}

function emitFinished(
  deps: SpawnDeps,
  parentSpanId: string,
  name: string,
  status: 'ok' | 'error' | 'cancelled',
  started: number,
  usage: TokenUsage,
): void {
  // `depth` is deliberately absent: subagent.finished is `.strict()` and only
  // subagent.started carries a depth field in event schema v1.
  emit(deps, parentSpanId, 'subagent.finished', {
    pattern: 'spawn',
    name,
    status,
    durationMs: elapsed(started),
    usage,
  } satisfies AgentEventPayload<'subagent.finished'>);
}

function emitBudget(
  deps: SpawnDeps,
  parentSpanId: string,
  agent: string,
  kind: 'depth' | 'subagents' | 'tokens',
  limit: number,
  used: number,
): void {
  emit(deps, parentSpanId, 'budget.exceeded', {
    kind,
    limit,
    used,
    agent,
  } satisfies AgentEventPayload<'budget.exceeded'>);
}

function emit(
  deps: SpawnDeps,
  parentSpanId: string,
  type: AgentEventType,
  payload: Record<string, unknown>,
): void {
  deps.onEvent({ type, payload, parentSpanId, spanHint: type });
}

function elapsed(started: number): number {
  return Math.max(0, Date.now() - started);
}

function preview(text: string, maxChars = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
