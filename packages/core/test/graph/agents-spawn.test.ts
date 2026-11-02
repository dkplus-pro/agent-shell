import type { StructuredToolInterface } from '@langchain/core/tools';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  createSpawnToolDefinition,
  SPAWN_TOOL_NAME,
  type SpawnDeps,
} from '../../src/agents/spawn.js';
import type { LeafAgentSpec } from '../../src/agents/react.js';
import { DEFAULT_LIMITS, mergeLimits, type Limits } from '../../src/limits.js';
import { CancelledError, SubagentError } from '../../src/errors/index.js';
import {
  makeEvent,
  validateEvent,
  type AgentEvent,
  type TokenUsage,
} from '../../src/events/schema.js';
import type { ToolContext } from '../../src/tools/types.js';
import { FakeChatModel, fakeModelHandle } from './helpers/fake-model.js';

const USAGE: TokenUsage = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

function leaf(name: string, toolNames: string[]): LeafAgentSpec {
  const model = new FakeChatModel({ replies: ['unused'], agentName: name });
  const tools: StructuredToolInterface[] = toolNames.map((toolName) =>
    tool(async () => `${toolName} ok`, {
      name: toolName,
      description: toolName,
      schema: z.object({}),
    }),
  );
  return { name, systemPrompt: `You are ${name}.`, model: fakeModelHandle(model), tools };
}

function context(signal: AbortSignal = AbortSignal.abort()): ToolContext {
  return {
    sessionId: 'ses_test',
    runId: 'run_test',
    spanId: 'spn_parent_tool',
    callId: 'call_test',
    toolName: SPAWN_TOOL_NAME,
    signal,
    workspaceRoot: '/tmp',
    allowOutsideWorkspace: false,
    log: () => undefined,
    resolveWorkspacePath: (input) => input,
  };
}

interface Harness {
  deps: SpawnDeps;
  events: AgentEvent[];
  runSubagent: ReturnType<typeof vi.fn>;
}

function harness(options?: {
  limits?: Partial<Limits>;
  parentDepth?: number;
  usage?: { subagents: number; tokens: number };
  agents?: Record<string, LeafAgentSpec>;
  parentTools?: string[];
  runSubagent?: (input: {
    name: string;
    task: string;
    tools: string[];
    depth: number;
    signal: AbortSignal;
  }) => Promise<{ output: string; usage: TokenUsage }>;
  maxSubagents?: number;
  signal?: AbortSignal;
}): Harness {
  const agents = options?.agents ?? { researcher: leaf('researcher', ['read_file']) };
  const parentTools = new Set(options?.parentTools ?? ['read_file']);
  const events: AgentEvent[] = [];
  const runSubagent = vi.fn(
    options?.runSubagent ?? (async () => ({ output: 'child answer', usage: USAGE })),
  );
  const deps: SpawnDeps = {
    parentDepth: options?.parentDepth ?? 0,
    limits: mergeLimits(DEFAULT_LIMITS, options?.limits),
    usage: options?.usage ?? { subagents: 0, tokens: 0 },
    agents,
    registry: {
      subset: (names) => ({ names: names.filter((name) => parentTools.has(name)) }),
    },
    maxSubagents: options?.maxSubagents ?? DEFAULT_LIMITS.maxSubagents,
    onEvent: (input) => {
      events.push(
        validateEvent(
          makeEvent({
            type: input.type,
            sessionId: 'ses_test',
            runId: 'run_test',
            spanId: `spn_${input.spanHint ?? input.type}`,
            ...(input.parentSpanId === undefined ? {} : { parentSpanId: input.parentSpanId }),
            source: 'subagent',
            payload: input.payload,
          }),
        ),
      );
    },
    signal: options?.signal ?? new AbortController().signal,
    runSubagent,
  };
  return { deps, events, runSubagent };
}

const args = { task: 'research the topic', agent: 'researcher', context: '' };

describe('createSpawnToolDefinition', () => {
  it('is the namespaced runtime tool with a read risk and an optional context arg', () => {
    const { deps } = harness();
    const definition = createSpawnToolDefinition(deps);
    expect(definition.name).toBe('runtime__spawn_subagent');
    expect(definition.name).toBe(SPAWN_TOOL_NAME);
    expect(definition.risk).toBe('read');
    expect(definition.schema.safeParse({ task: 't', agent: 'a' }).success).toBe(true);
    expect(definition.schema.safeParse({ task: 't', agent: 'a', context: 'c' }).success).toBe(true);
    expect(definition.schema.safeParse({ task: '', agent: 'a' }).success).toBe(false);
  });

  it('runs the child and emits started/finished with schema-valid payloads', async () => {
    const { deps, events, runSubagent } = harness();
    const definition = createSpawnToolDefinition(deps);
    const output = await definition.execute(args, context(new AbortController().signal));

    expect(output).toBe('child answer');
    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(['subagent.started', 'subagent.finished']);
    expect(events[0]?.payload).toEqual({
      pattern: 'spawn',
      name: 'researcher',
      depth: 1,
      taskPreview: 'research the topic',
    });
    expect(events[0]?.parentSpanId).toBe('spn_parent_tool');
    expect(events[1]?.payload).toMatchObject({
      pattern: 'spawn',
      name: 'researcher',
      status: 'ok',
      usage: USAGE,
    });
  });

  it('passes the explicit context to the child and the resolved tool subset', async () => {
    const { deps, runSubagent } = harness();
    const definition = createSpawnToolDefinition(deps);
    await definition.execute(
      { ...args, context: 'parent notes' },
      context(new AbortController().signal),
    );
    const input = runSubagent.mock.calls[0]?.[0];
    expect(input?.context).toBe('parent notes');
    expect(input?.tools).toEqual(['read_file']);
    expect(input?.depth).toBe(1);
  });

  it('rejects a child that would exceed the depth budget', async () => {
    const { deps, events, runSubagent } = harness({
      limits: { maxSubagentDepth: 1 },
      parentDepth: 1,
    });
    const definition = createSpawnToolDefinition(deps);
    await expect(definition.execute(args, context(new AbortController().signal))).rejects.toThrow(
      SubagentError,
    );
    await expect(definition.execute(args, context(new AbortController().signal))).rejects.toThrow(
      /depth/,
    );
    expect(runSubagent).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['budget.exceeded', 'budget.exceeded']);
    expect(events[0]?.payload).toMatchObject({
      kind: 'depth',
      limit: 1,
      used: 2,
      agent: 'researcher',
    });
  });

  it('rejects a child that would exceed the subagent count', async () => {
    const { deps, events, runSubagent } = harness({
      usage: { subagents: 2, tokens: 0 },
      maxSubagents: 2,
    });
    await expect(
      createSpawnToolDefinition(deps).execute(args, context(new AbortController().signal)),
    ).rejects.toThrow(/subagents/);
    expect(runSubagent).not.toHaveBeenCalled();
    expect(events[0]?.payload).toMatchObject({ kind: 'subagents', limit: 2, used: 3 });
  });

  it('rejects when the shared token budget is already spent', async () => {
    const { deps, events, runSubagent } = harness({
      limits: { tokenBudget: 100 },
      usage: { subagents: 0, tokens: 100 },
    });
    await expect(
      createSpawnToolDefinition(deps).execute(args, context(new AbortController().signal)),
    ).rejects.toThrow(/tokens/);
    expect(runSubagent).not.toHaveBeenCalled();
    expect(events[0]?.payload).toMatchObject({ kind: 'tokens', limit: 100, used: 100 });
  });

  it('lists the available agents for an unknown agent name', async () => {
    const { deps, runSubagent } = harness({
      agents: {
        researcher: leaf('researcher', ['read_file']),
        writer: leaf('writer', ['read_file']),
      },
    });
    await expect(
      createSpawnToolDefinition(deps).execute(
        { ...args, agent: 'ghost' },
        context(new AbortController().signal),
      ),
    ).rejects.toThrow('Unknown subagent "ghost". Available agents: researcher, writer.');
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it("rejects a child whose tools are not a subset of the parent's", async () => {
    const { deps, runSubagent } = harness({
      agents: { risky: leaf('risky', ['delete_file']) },
      parentTools: ['read_file'],
    });
    await expect(
      createSpawnToolDefinition(deps).execute(
        { ...args, agent: 'risky' },
        context(new AbortController().signal),
      ),
    ).rejects.toThrow(/not a subset of the parent's tool set/);
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it('returns a readable error output when the child fails', async () => {
    const { deps, events } = harness({
      runSubagent: async () => {
        throw new Error('provider exploded');
      },
    });
    const output = await createSpawnToolDefinition(deps).execute(
      args,
      context(new AbortController().signal),
    );
    expect(output).toBe('subagent failed: provider exploded');
    expect(events[1]?.payload).toMatchObject({ status: 'error', name: 'researcher' });
  });

  it('throws CancelledError when the parent signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, runSubagent, events } = harness({ signal: controller.signal });
    await expect(
      createSpawnToolDefinition(deps).execute(args, context(new AbortController().signal)),
    ).rejects.toThrow(CancelledError);
    expect(runSubagent).not.toHaveBeenCalled();
    // A cancelled-before-start spawn leaves no unbalanced subagent.started.
    expect(events).toHaveLength(0);
  });

  it('cascades a mid-flight parent cancel into the child signal and finishes as cancelled', async () => {
    const controller = new AbortController();
    const childSignals: AbortSignal[] = [];
    const { deps, events } = harness({
      signal: controller.signal,
      runSubagent: ({ signal }) =>
        new Promise((resolve) => {
          childSignals.push(signal);
          signal.addEventListener('abort', () => resolve({ output: 'never used', usage: USAGE }), {
            once: true,
          });
        }),
    });
    const definition = createSpawnToolDefinition(deps);
    const running = definition.execute(args, context(new AbortController().signal));
    await vi.waitFor(() => expect(childSignals).toHaveLength(1));
    controller.abort();

    await expect(running).rejects.toThrow(CancelledError);
    expect(childSignals[0]?.aborted).toBe(true);
    expect(events.map((event) => event.type)).toEqual(['subagent.started', 'subagent.finished']);
    expect(events[1]?.payload).toMatchObject({ status: 'cancelled', name: 'researcher' });
  });

  it('cascades the tool context signal so a tool-level cancel reaches the child', async () => {
    const toolController = new AbortController();
    const childSignals: AbortSignal[] = [];
    const { deps } = harness({
      runSubagent: ({ signal }) =>
        new Promise((resolve) => {
          childSignals.push(signal);
          signal.addEventListener('abort', () => resolve({ output: 'never used', usage: USAGE }), {
            once: true,
          });
        }),
    });
    const definition = createSpawnToolDefinition(deps);
    const running = definition.execute(args, context(toolController.signal));
    await vi.waitFor(() => expect(childSignals).toHaveLength(1));
    toolController.abort();
    await expect(running).rejects.toThrow(CancelledError);
  });
});
