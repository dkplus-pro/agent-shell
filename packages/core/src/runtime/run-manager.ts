import fs from 'node:fs';
import path from 'node:path';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { Command, MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import {
  ApprovalDeniedError,
  BudgetExceededError,
  CancelledError,
  ConfigError,
  ShellError,
  exitCodeFor,
} from '../errors/index.js';
import { newRunId, newSessionId, newSpanId } from '../ids.js';
import type {
  AgentEvent,
  AgentEventType,
  NewEvent,
  RunStatus,
  TokenUsage,
} from '../events/schema.js';
import { EventBus, type EventSink } from '../events/bus.js';
import { JsonlFileSink } from '../events/sinks.js';
import { truncateText } from '../events/truncate.js';
import { collectEnvSecretValues } from '../events/redaction.js';
import {
  DEFAULT_LIMITS,
  checkBudget,
  emptyUsage,
  mergeLimits,
  type BudgetUsage,
  type Limits,
} from '../limits.js';
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  AllowlistRule,
} from '../approvals/policy.js';
import { evaluateApproval } from '../approvals/policy.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { ChatModelHandle, ProviderRegistry } from '../providers/types.js';
import { parseModelRef, formatModelRef } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { resolveWorkspacePath } from '../tools/path-guard.js';
import { toLangChainTools } from '../tools/langchain.js';
import { buildSingleAgentGraph, messageText, messageToolCalls } from '../graph/single.js';
import { classifyHandoffToolName } from '../agents/handoff.js';
import { buildSupervisorGraph } from '../agents/supervisor.js';
import { buildSwarmGraph } from '../agents/swarm.js';
import type { LeafAgentSpec } from '../agents/react.js';
import {
  createSpawnToolDefinition,
  SPAWN_TOOL_NAME,
  type SpawnRequest,
  type SpawnResult,
} from '../agents/spawn.js';
import type { RunOptions, RunSummary } from './types.js';
import type { RegisteredTool } from '../tools/registry.js';

function lastMessageText(result: Record<string, unknown>): string {
  const messages = result['messages'];
  const list = Array.isArray(messages) ? (messages as BaseMessage[]) : [];
  return messageText(list.at(-1));
}

const RECURSION_PER_STEP = 2;

export interface RunManagerDeps {
  config: ResolvedConfig;
  dataDir: string;
  workspaceRoot: string;
  providers: ProviderRegistry;
  registry: ToolRegistry;
  interactive: boolean;
  yolo?: boolean;
  allowOutsideWorkspace?: boolean;
  checkpointer?: BaseCheckpointSaver;
  extraSecretValues?: string[];
  approvalHandler?: ApprovalHandler;
  mcpRiskOverrides?: Record<string, Record<string, string>>;
}

interface MultiAgentGraph {
  stream: (input: unknown, config: unknown) => Promise<AsyncIterable<unknown>>;
  getState: (
    config: unknown,
  ) => Promise<{ values?: unknown; tasks?: Array<{ interrupts?: Array<{ value?: unknown }> }> }>;
}

function messagesOf(delta: unknown): BaseMessage[] {
  if (Array.isArray(delta)) return delta as BaseMessage[];
  if (delta && typeof delta === 'object' && 'messages' in delta) {
    const messages = (delta as { messages: unknown }).messages;
    return Array.isArray(messages) ? (messages as BaseMessage[]) : [];
  }
  return [];
}

function usageOf(
  message: BaseMessage,
): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  const meta = (message as { usage_metadata?: unknown }).usage_metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const record = meta as Record<string, unknown>;
  const inputTokens = Number(record['input_tokens'] ?? record['inputTokens'] ?? 0);
  const outputTokens = Number(record['output_tokens'] ?? record['outputTokens'] ?? 0);
  const totalTokens = Number(
    record['total_tokens'] ?? record['totalTokens'] ?? inputTokens + outputTokens,
  );
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function lastUserText(messages: BaseMessage[]): string {
  const human = [...messages].reverse().find((message) => message.getType?.() === 'human');
  return human ? messageText(human) : '';
}

function previewText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

function interruptsFromState(state: unknown): Array<{ id?: string; value?: unknown }> {
  const tasks = (
    state as { tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }> }
  )?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((task) => task.interrupts ?? []);
}

type ChildRunInput = SpawnRequest & {
  ids: { sessionId: string; runId: string; rootSpanId: string };
  usage: BudgetUsage;
  limits: Limits;
  emit: (event: NewEvent<AgentEventType>) => void;
  parentSpanId: string;
};

export interface ActiveRun {
  runId: string;
  sessionId: string;
  tracePath: string;
  cancel(reason?: string): void;
}

class CallbackSink implements EventSink {
  readonly name = 'callback';
  constructor(private readonly onEvent: (event: AgentEvent) => void) {}
  write(events: AgentEvent[]): void {
    for (const event of events) this.onEvent(event);
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export function traceFilePath(dataDir: string, sessionId: string, runId: string): string {
  return path.join(dataDir, 'traces', sessionId, `${runId}.jsonl`);
}

function ensureTraceDir(file: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export class RunManager {
  private readonly deps: RunManagerDeps;
  private active: ActiveRun | undefined;

  private readonly handleCache = new Map<string, ChatModelHandle>();

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
  }

  /** Handles are cached per (provider:model, agent) so each agent gets its own script. */
  private async handleFor(ref: string, agent?: string): Promise<ChatModelHandle> {
    const key = agent === undefined ? ref : `${ref}#${agent}`;
    const cached = this.handleCache.get(key);
    if (cached) return cached;
    const created = await this.deps.providers.create(
      ref,
      agent === undefined ? undefined : { agent },
    );
    this.handleCache.set(key, created);
    return created;
  }

  private refForAgent(
    agentDef: { provider?: string; model?: string },
    fallbackRef: string,
  ): string {
    if (!agentDef.provider) return fallbackRef;
    const model = agentDef.model ?? parseModelRef(fallbackRef).model ?? '';
    return formatModelRef({
      providerId: agentDef.provider,
      ...(model.length > 0 ? { model } : {}),
    });
  }

  get currentRun(): ActiveRun | undefined {
    return this.active;
  }

  async startRun(options: RunOptions): Promise<RunSummary> {
    const config = this.deps.config;
    const sessionId = options.sessionId ?? newSessionId();
    const runId = newRunId();
    const rootSpanId = newSpanId();
    const startedClock = process.hrtime.bigint();

    const tracePath = traceFilePath(this.deps.dataDir, sessionId, runId);
    ensureTraceDir(tracePath);

    const presetName = options.preset ?? config.defaults.preset ?? 'single';
    const preset = config.presets[presetName] ?? {
      kind: 'single' as const,
      agent: config.defaults.agent,
    };
    const providerRef = options.provider ?? config.defaults.provider ?? firstProviderId(config);
    const { providerId, model } = parseModelRef(providerRef);

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else
        options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
          once: true,
        });
    }
    this.active = {
      runId,
      sessionId,
      tracePath,
      cancel: (reason?: string) => controller.abort(reason ?? 'cancelled'),
    };

    const sinks: EventSink[] = [new JsonlFileSink(tracePath)];
    if (options.onEvent) sinks.push(new CallbackSink(options.onEvent));
    const bus = new EventBus({
      sinks,
      maxFieldBytes: config.trace.maxFieldBytes,
      redaction: {
        secretValues: [
          ...collectEnvSecretValues(providerSecretVariables(config)),
          ...(this.deps.extraSecretValues ?? []),
        ],
        envPatterns: config.trace.redactEnvPrefixes,
      },
    });

    const counters = { approvals: 0, subagents: 0 };
    const root = { sessionId, runId, spanId: rootSpanId };
    const emit = (input: NewEvent<AgentEventType>): void => {
      if (input.type === 'tool.approval.requested') counters.approvals += 1;
      bus.emit(input);
    };

    const ids = { sessionId, runId, rootSpanId };
    const limits = limitsForPreset(config, preset);
    const usage: BudgetUsage = { ...emptyUsage(), elapsedMs: 0 };

    emit({
      type: options.resume ? 'session.resumed' : 'session.started',
      source: 'runtime',
      ...root,
      payload: { sessionId, threadId: sessionId, ...(options.resume ? {} : {}) },
    });

    const inputPreview = truncateText(options.task, 2048);
    emit({
      type: 'run.started',
      source: 'runtime',
      ...root,
      payload: {
        inputPreview: inputPreview.text,
        provider: providerId,
        model: model ?? '',
        preset: presetName,
      },
    });

    let status: RunStatus = 'ok';
    let output = '';
    let failure: unknown;

    try {
      const handle = await this.handleFor(providerRef, agentNameOf(preset));
      if (preset.kind === 'single') {
        const agentName = preset.agent;
        const agentDef = config.agents[agentName];
        if (!agentDef)
          throw new ConfigError(`Agent "${agentName}" is not defined in config.agents.`);
        const runRegistry = await this.withSpawnTool({
          base: this.deps.registry,
          agentName,
          ids,
          limits,
          usage,
          emit,
          controller,
          fallbackRef: providerRef,
          parentToolNames: this.deps.registry.names(),
        });
        const scoped = scopeRegistry(runRegistry, agentDef.tools);
        const graph = buildSingleAgentGraph(
          {
            agentName,
            systemPrompt: agentDef.prompt,
            handle,
            providerId,
            modelId: model ?? '',
            registry: scoped,
            createExecutor: (nodeEmit, approval) =>
              new ToolExecutor({
                registry: scoped,
                emit: nodeEmit,
                approval,
                approvals: approvalContext(config, {
                  interactive: this.deps.interactive,
                  yolo: this.deps.yolo,
                }),
                interactive: this.deps.interactive || this.deps.yolo === true,
                yolo: this.deps.yolo === true,
                workspaceRoot: this.deps.workspaceRoot,
                allowOutsideWorkspace: this.deps.allowOutsideWorkspace === true,
                ids,
              }),
            emit,
            limits,
            usage,
            ids,
            approvals: approvalContext(config, {
              interactive: this.deps.interactive,
              yolo: this.deps.yolo,
            }),
            workspaceRoot: this.deps.workspaceRoot,
            allowOutsideWorkspace: this.deps.allowOutsideWorkspace === true,
            recursionLimit: limits.maxSteps * RECURSION_PER_STEP + 4,
            signal: controller.signal,
            ...(options.onToken ? { onToken: options.onToken } : {}),
          },
          this.checkpointer(),
        );

        const final = await this.driveGraph(graph, {
          messages: [new HumanMessage({ content: options.task })],
          ids,
          controller,
          approvalHandler: options.onApproval
            ? {
                decide: async (request) =>
                  (await options.onApproval?.(request)) ?? denyDecision('no handler'),
              }
            : this.deps.approvalHandler,
          timeoutMs: config.approvals.timeoutMs,
          emit,
          limits,
          usage,
          startedClock,
        });
        output = lastMessageText(final);
      } else {
        const spec = await this.buildMultiAgentSpec(preset, providerRef, providerId, model ?? '', {
          emit,
          ids,
          limits,
          usage,
          controller,
        });
        const final = await this.driveMultiAgent(spec.graph, {
          messages: [new HumanMessage({ content: options.task })],
          ids,
          controller,
          approvalHandler: options.onApproval
            ? {
                decide: async (request) =>
                  (await options.onApproval?.(request)) ?? denyDecision('no handler'),
              }
            : this.deps.approvalHandler,
          timeoutMs: config.approvals.timeoutMs,
          emit,
          limits,
          usage,
          startedClock,
          subagentNames: spec.agentNames,
          pattern: preset.kind,
          onSubagent: () => {
            counters.subagents += 1;
          },
        });
        output = extractMultiAgentOutput(final);
      }

      if (controller.signal.aborted) throw new CancelledError();
      const budget = checkBudget(usage, limits);
      if (budget.exceeded) {
        throw new BudgetExceededError(budget.kind ?? 'steps', budget.limit ?? 0, budget.used ?? 0);
      }
    } catch (rawError) {
      const aborted = controller.signal.aborted;
      const error =
        aborted && !(rawError instanceof ShellError)
          ? new CancelledError(rawError instanceof Error ? rawError.message : 'Run cancelled')
          : rawError;
      failure = error;
      if (error instanceof CancelledError || aborted) status = 'cancelled';
      else if (error instanceof ApprovalDeniedError) status = 'denied';
      else if (error instanceof BudgetExceededError) status = 'error';
      else status = 'error';
      emit({
        type: 'run.error',
        source: 'runtime',
        ...root,
        payload: {
          error: {
            name: error instanceof Error ? error.name : 'UnknownError',
            code:
              error instanceof Error && 'code' in error
                ? String((error as unknown as { code: unknown }).code)
                : undefined,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }

    const durationMs = Number(process.hrtime.bigint() - startedClock) / 1_000_000;
    emit({
      type: 'run.finished',
      source: 'runtime',
      ...root,
      payload: {
        status,
        durationMs: Math.round(durationMs),
        usage: usageToEvent(usage),
        stepCount: usage.steps,
        subagentCount: usage.subagents + counters.subagents,
      },
    });

    try {
      await bus.close();
    } catch (error) {
      if (!failure) failure = error;
    }
    this.active = undefined;

    if (failure) {
      const summary = this.buildSummary({
        ids,
        presetName,
        providerId,
        modelId: model ?? '',
        status,
        output,
        usage,
        durationMs: Math.round(durationMs),
        approvals: counters.approvals,
        subagents: counters.subagents + usage.subagents,
        tracePath,
        error: failure,
      });
      void summary;
      throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), {
        exitCode: exitCodeFor(failure),
        runId,
        sessionId,
        tracePath,
      });
    }

    return this.buildSummary({
      ids,
      presetName,
      providerId,
      modelId: model ?? '',
      status,
      output,
      usage,
      durationMs: Math.round(durationMs),
      approvals: counters.approvals,
      subagents: counters.subagents,
      tracePath,
    });
  }

  /** Isolated child run for the spawn tool: fresh messages, subset tools, own spans. */
  private async runChild(input: ChildRunInput): Promise<SpawnResult> {
    const config = this.deps.config;
    const agentDef = config.agents[input.name];
    if (!agentDef) {
      throw new ConfigError(`Subagent "${input.name}" is not defined in config.agents.`);
    }
    const childIds = {
      sessionId: input.ids.sessionId,
      runId: input.ids.runId,
      rootSpanId: newSpanId(),
    };
    const childRegistry = await this.withSpawnTool({
      base: this.deps.registry,
      agentName: agentDef.name,
      parentDepth: input.depth,
      ids: { sessionId: input.ids.sessionId, runId: input.ids.runId, rootSpanId: newSpanId() },
      limits: input.limits,
      usage: input.usage,
      emit: input.emit,
      controller: { signal: input.signal } as unknown as AbortController,
      fallbackRef: agentDef.provider
        ? formatModelRef({
            providerId: agentDef.provider,
            ...(agentDef.model ? { model: agentDef.model } : {}),
          })
        : (this.deps.config.defaults.provider ?? firstProviderId(this.deps.config)),
    });
    const scoped = scopeRegistry(
      childRegistry,
      agentDef.tools.length > 0 ? agentDef.tools : input.tools,
    );
    for (const name of input.tools) {
      if (!scoped.has(name)) {
        throw new ConfigError(
          `Subagent ${input.name} may not use tool "${name}": not part of the parent tool set.`,
        );
      }
    }

    const ref = agentDef.provider
      ? formatModelRef({
          providerId: agentDef.provider,
          ...(agentDef.model ? { model: agentDef.model } : {}),
        })
      : (config.defaults.provider ?? firstProviderId(config));
    const handle = await this.handleFor(ref, agentDef.name);
    const { providerId, model } = parseModelRef(ref);
    const childUsage: BudgetUsage = { ...emptyUsage(), depth: input.depth };
    const childLimits = mergeLimits(DEFAULT_LIMITS, { maxSteps: 20 }, agentDef.limits);

    const graph = buildSingleAgentGraph(
      {
        agentName: agentDef.name,
        systemPrompt: agentDef.prompt,
        handle,
        providerId,
        modelId: model ?? '',
        registry: scoped,
        createExecutor: (nodeEmit, approval) =>
          new ToolExecutor({
            registry: scoped,
            emit: nodeEmit,
            approval,
            approvals: approvalContext(config, {
              interactive: this.deps.interactive,
              yolo: this.deps.yolo,
            }),
            interactive: this.deps.interactive,
            yolo: this.deps.yolo === true,
            workspaceRoot: this.deps.workspaceRoot,
            allowOutsideWorkspace: this.deps.allowOutsideWorkspace === true,
            ids: childIds,
          }),
        emit: (event) =>
          input.emit({ ...event, runId: input.ids.runId, parentSpanId: input.parentSpanId }),
        limits: childLimits,
        usage: childUsage,
        ids: childIds,
        approvals: approvalContext(config, {
          interactive: this.deps.interactive,
          yolo: this.deps.yolo,
        }),
        workspaceRoot: this.deps.workspaceRoot,
        allowOutsideWorkspace: this.deps.allowOutsideWorkspace === true,
        recursionLimit: childLimits.maxSteps * RECURSION_PER_STEP + 4,
        signal: input.signal,
      },
      this.checkpointer(),
    );

    const messages: BaseMessage[] = [
      new HumanMessage({
        content: input.context ? `${input.context}\n\n${input.task}` : input.task,
      }),
    ];
    const final = await this.driveGraph(graph, {
      messages,
      ids: childIds,
      controller: { signal: input.signal } as unknown as AbortController,
      approvalHandler: this.deps.approvalHandler,
      timeoutMs: config.approvals.timeoutMs,
      emit: input.emit,
      limits: childLimits,
      usage: childUsage,
      startedClock: process.hrtime.bigint(),
    });

    input.usage.tokens += childUsage.tokens;
    input.usage.inputTokens += childUsage.inputTokens;
    input.usage.outputTokens += childUsage.outputTokens;
    if (!childUsage.estimated) input.usage.estimated = false;
    input.usage.subagents += 1;
    input.usage.depth = Math.max(input.usage.depth, input.depth);
    return { output: lastMessageText(final), usage: usageToEvent(childUsage) };
  }

  /** `runtime__spawn_subagent` is registered per run so its budget view is live. */
  private async withSpawnTool(input: {
    base: ToolRegistry;
    agentName: string;
    parentDepth?: number;
    ids: { sessionId: string; runId: string; rootSpanId: string };
    limits: Limits;
    usage: BudgetUsage;
    emit: (event: NewEvent<AgentEventType>) => void;
    controller: AbortController;
    fallbackRef: string;
    parentToolNames?: string[];
  }): Promise<ToolRegistry> {
    const config = this.deps.config;
    const childAgents = Object.keys(config.agents).filter((name) => name !== input.agentName);
    if (childAgents.length === 0 || input.limits.maxSubagents <= 0) return input.base;

    const cloned = input.base.subset(input.base.names());
    if (cloned.has(SPAWN_TOOL_NAME)) return cloned;

    const agents: Record<string, LeafAgentSpec> = {};
    for (const [name, agentDef] of Object.entries(config.agents)) {
      if (name === input.agentName) continue;
      const scoped = scopeRegistry(input.base, agentDef.tools);
      agents[name] = {
        name,
        systemPrompt: agentDef.prompt,
        model: await this.handleFor(this.refForAgent(agentDef, input.fallbackRef), name),
        tools: toLangChainTools(scoped.list(), (_tool, _args) => {
          throw new ConfigError('Subagent tools execute through the parent run only.');
        }),
      };
    }

    // registerRuntime() namespaces, so hand it the bare primitive name.
    const spawnTool = createSpawnToolDefinition({
      parentDepth: input.parentDepth ?? 0,
      limits: input.limits,
      usage: input.usage,
      agents,
      registry: { subset: (names: string[]) => ({ names }) },
      maxSubagents: input.limits.maxSubagents,
      signal: input.controller.signal,
      onEvent: (event) =>
        input.emit({
          type: event.type,
          source: 'subagent',
          sessionId: input.ids.sessionId,
          runId: input.ids.runId,
          // spanHint is a label, never an id: envelope ids must match /^spn_/
          // or the event is dropped when the trace is read back.
          spanId: newSpanId(),
          parentSpanId: event.parentSpanId ?? input.ids.rootSpanId,
          payload: event.payload,
        }),
      runSubagent: (request: SpawnRequest) =>
        this.runChild({
          ...request,
          ids: input.ids,
          usage: input.usage,
          limits: input.limits,
          emit: input.emit,
          parentSpanId: input.ids.rootSpanId,
        }),
    }) as never;
    cloned.registerRuntime({
      ...(spawnTool as unknown as { name: string }),
      name: 'spawn_subagent',
    } as never);
    return cloned;
  }

  /**
   * Supervisor/swarm graphs are built by upstream prebuilts, so the run cannot
   * instrument their model or tool nodes directly. Instead every `updates` chunk
   * is folded into our own event stream: agent spans, handoffs and token usage.
   */
  private async driveMultiAgent(
    graphInput: unknown,
    opts: {
      messages: BaseMessage[];
      ids: { sessionId: string; runId: string; rootSpanId: string };
      controller: AbortController;
      approvalHandler?: ApprovalHandler;
      timeoutMs: number;
      emit: (event: NewEvent<AgentEventType>) => void;
      limits: Limits;
      usage: BudgetUsage;
      startedClock: bigint;
      subagentNames: string[];
      pattern: 'supervisor' | 'swarm';
      onSubagent: (name: string) => void;
    },
  ): Promise<Record<string, unknown>> {
    const graph = graphInput as MultiAgentGraph;
    const threadConfig = {
      configurable: { thread_id: opts.ids.sessionId },
      recursionLimit: opts.limits.maxSteps * RECURSION_PER_STEP + 8,
      signal: opts.controller.signal,
    };
    const seen = new Set<string>();
    let input: unknown = { messages: opts.messages };
    let guard = 0;

    for (;;) {
      if (opts.controller.signal.aborted) throw new CancelledError();
      opts.usage.elapsedMs = Number(process.hrtime.bigint() - opts.startedClock) / 1_000_000;

      const stream = await graph.stream(input, { ...threadConfig, streamMode: 'updates' });
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        for (const [node, delta] of Object.entries(chunk)) {
          const messages = messagesOf(delta);
          for (const message of messages) {
            const usage = usageOf(message);
            if (usage) {
              opts.usage.tokens += usage.totalTokens;
              opts.usage.inputTokens += usage.inputTokens;
              opts.usage.outputTokens += usage.outputTokens;
              opts.usage.estimated = false;
            }
            for (const call of messageToolCalls(message)) {
              const handoff = classifyHandoffToolName(String(call.name ?? ''), opts.pattern);
              if (handoff) {
                opts.emit({
                  type: 'subagent.handoff',
                  source: 'subagent',
                  sessionId: opts.ids.sessionId,
                  runId: opts.ids.runId,
                  spanId: newSpanId(),
                  parentSpanId: opts.ids.rootSpanId,
                  payload: {
                    from: node,
                    to: handoff.to,
                    pattern: handoff.pattern,
                    ...(call.args && typeof call.args.reason === 'string'
                      ? { reason: call.args.reason }
                      : {}),
                  },
                });
              }
            }
          }
          if (opts.subagentNames.includes(node) || node === '__start__') {
            if (node === '__start__') continue;
            const spanId = newSpanId();
            opts.emit({
              type: 'subagent.started',
              source: 'subagent',
              sessionId: opts.ids.sessionId,
              runId: opts.ids.runId,
              spanId,
              parentSpanId: opts.ids.rootSpanId,
              payload: {
                pattern: opts.pattern,
                name: node,
                depth: 1,
                taskPreview: previewText(lastUserText(messages)),
              },
            });
            const first = !seen.has(node);
            seen.add(node);
            if (first) opts.onSubagent(node);
            opts.usage.steps += 1;
            opts.emit({
              type: 'subagent.finished',
              source: 'subagent',
              sessionId: opts.ids.sessionId,
              runId: opts.ids.runId,
              spanId: newSpanId(),
              parentSpanId: spanId,
              payload: {
                pattern: opts.pattern,
                name: node,
                status: 'ok',
                durationMs: 0,
                usage: usageToEvent(opts.usage),
              },
            });
          }
        }
      }

      const state = await graph.getState(threadConfig);
      const pending = interruptsFromState(state);
      if (pending.length === 0) return (state?.values ?? {}) as Record<string, unknown>;
      if (guard++ > 100) throw new CancelledError('approval loop exceeded guard');
      const request = pending[0]?.value as unknown as ApprovalRequest;
      const decision = await resolveDecision(request, opts);
      input = new Command({ resume: decision });
    }
  }

  private checkpointer(): BaseCheckpointSaver {
    return this.deps.checkpointer ?? new MemorySaver();
  }

  private async buildMultiAgentSpec(
    preset: Extract<ResolvedConfig['presets'][string], { kind: 'supervisor' | 'swarm' }>,
    providerRef: string,
    providerId: string,
    modelId: string,
    ctx: {
      emit: (event: NewEvent<AgentEventType>) => void;
      ids: { sessionId: string; runId: string; rootSpanId: string };
      limits: Limits;
      usage: BudgetUsage;
      controller: AbortController;
    },
  ): Promise<{
    graph: {
      invoke: (input: unknown, config: unknown) => Promise<never>;
      stream: (input: unknown, config: unknown) => AsyncIterable<unknown>;
    };
    agentNames: string[];
  }> {
    const config = this.deps.config;
    const names =
      preset.kind === 'supervisor' ? [preset.supervisor, ...preset.agents] : preset.agents;
    const specs: LeafAgentSpec[] = [];
    for (const name of names) {
      const agentDef = config.agents[name];
      if (!agentDef) throw new ConfigError(`Agent "${name}" referenced by preset is not defined.`);
      const agentHandle =
        agentDef.provider && agentDef.provider !== providerId
          ? await this.handleFor(
              formatModelRef({
                providerId: agentDef.provider,
                ...(agentDef.model ? { model: agentDef.model } : { model: modelId }),
              }),
              name,
            )
          : await this.handleFor(providerRef, name);
      const scoped = scopeRegistry(this.deps.registry, agentDef.tools);
      specs.push({
        name,
        systemPrompt: agentDef.prompt,
        model: agentHandle,
        tools: toLangChainTools(
          scoped.list(),
          async (tool: RegisteredTool, args: Record<string, unknown>) => {
            const result = await new ToolExecutor({
              registry: scoped,
              emit: (event) =>
                ctx.emit({ ...event, parentSpanId: event.parentSpanId ?? ctx.ids.rootSpanId }),
              approval: {
                request: () => ({ decision: 'approve', actor: 'policy', reason: 'preset-tool' }),
              },
              approvals: approvalContext(config, {
                interactive: this.deps.interactive,
                yolo: this.deps.yolo,
              }),
              interactive: this.deps.interactive,
              yolo: this.deps.yolo === true,
              workspaceRoot: this.deps.workspaceRoot,
              allowOutsideWorkspace: this.deps.allowOutsideWorkspace === true,
              ids: ctx.ids,
            }).execute(
              { name: tool.name, args, callId: `${tool.name}-${Date.now()}`, agent: name },
              { signal: ctx.controller.signal },
            );
            return result.content;
          },
        ),
      });
    }

    const checkpointer = this.checkpointer();
    if (preset.kind === 'supervisor') {
      const [supervisor, ...workers] = specs;
      if (!supervisor) throw new ConfigError('Supervisor preset has no supervisor agent.');
      const built = buildSupervisorGraph({
        supervisor,
        workers,
        outputMode: preset.outputMode,
        checkpointer,
      });
      return { graph: built.graph as never, agentNames: built.agentNames };
    }
    const built = buildSwarmGraph({
      agents: specs,
      defaultActiveAgent: preset.defaultActiveAgent,
      checkpointer,
    });
    return { graph: built.graph as never, agentNames: built.agentNames };
  }

  private async driveGraph(
    graphInput: unknown,
    opts: {
      messages: BaseMessage[];
      ids: { sessionId: string; runId: string; rootSpanId: string };
      controller: AbortController;
      approvalHandler?: ApprovalHandler;
      timeoutMs: number;
      emit: (event: NewEvent<AgentEventType>) => void;
      limits: Limits;
      usage: BudgetUsage;
      startedClock: bigint;
      streamUpdates?: boolean;
      subagentNames?: string[];
      pattern?: 'supervisor' | 'swarm';
    },
  ): Promise<Record<string, unknown>> {
    const graph = graphInput as {
      invoke: (input: unknown, config: unknown) => Promise<Record<string, unknown>>;
    };
    const threadConfig = {
      configurable: { thread_id: opts.ids.sessionId },
      recursionLimit: opts.limits.maxSteps * RECURSION_PER_STEP + 8,
      signal: opts.controller.signal,
    };

    let result = (await graph.invoke({ messages: opts.messages }, threadConfig)) as Record<
      string,
      unknown
    >;
    let guard = 0;

    while (true) {
      if (opts.controller.signal.aborted) throw new CancelledError();
      opts.usage.elapsedMs = Number(process.hrtime.bigint() - opts.startedClock) / 1_000_000;

      const pending = readInterrupts(result);
      if (pending.length === 0) return result;
      if (guard++ > 200) throw new CancelledError('approval loop exceeded guard');

      const request = pending[0]?.value as unknown as ApprovalRequest;
      const decision = await resolveDecision(request, opts);
      result = (await graph.invoke(new Command({ resume: decision }), threadConfig)) as Record<
        string,
        unknown
      >;
    }
  }

  private buildSummary(input: {
    ids: { sessionId: string; runId: string };
    presetName: string;
    providerId: string;
    modelId: string;
    status: RunStatus;
    output: string;
    usage: BudgetUsage;
    durationMs: number;
    approvals: number;
    subagents: number;
    tracePath: string;
    error?: unknown;
  }): RunSummary {
    return {
      runId: input.ids.runId,
      sessionId: input.ids.sessionId,
      status: input.status,
      output: input.output,
      usage: usageToEvent(input.usage),
      stepCount: input.usage.steps,
      subagentCount: input.subagents + input.usage.subagents,
      approvalCount: input.approvals,
      durationMs: input.durationMs,
      tracePath: input.tracePath,
      preset: input.presetName,
      provider: input.providerId,
      model: input.modelId,
      ...(input.error === undefined
        ? {}
        : {
            error: {
              name: input.error instanceof Error ? input.error.name : 'UnknownError',
              message: input.error instanceof Error ? input.error.message : String(input.error),
            },
          }),
    };
  }
}

export function readInterrupts(result: unknown): Array<{ id?: string; value?: unknown }> {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  for (const key of ['__interrupt__', '__interrupts']) {
    const value = record[key];
    if (Array.isArray(value) && value.length > 0)
      return value as Array<{ id?: string; value?: unknown }>;
  }
  return [];
}

async function resolveDecision(
  request: ApprovalRequest,
  opts: {
    approvalHandler?: ApprovalHandler;
    timeoutMs: number;
    emit: (event: NewEvent<AgentEventType>) => void;
    ids: { sessionId: string; runId: string; rootSpanId: string };
  },
): Promise<ApprovalDecision> {
  if (!request || typeof request !== 'object' || typeof request.tool !== 'string') {
    return denyDecision('malformed approval interrupt');
  }
  if (!opts.approvalHandler) return denyDecision('non-interactive');
  if (opts.timeoutMs > 0) {
    const timeout = new Promise<ApprovalDecision>((resolve) =>
      setTimeout(() => resolve(denyDecision('timeout')), opts.timeoutMs).unref(),
    );
    return await Promise.race([opts.approvalHandler.decide(request), timeout]);
  }
  return await opts.approvalHandler.decide(request);
}

/** The agent that owns the first model call of a preset run. */
function agentNameOf(preset: {
  kind: string;
  agent?: string;
  supervisor?: string;
  defaultActiveAgent?: string;
}): string | undefined {
  if (preset.kind === 'single') return preset.agent;
  if (preset.kind === 'supervisor') return preset.supervisor;
  return preset.defaultActiveAgent;
}

function denyDecision(reason: string): ApprovalDecision {
  return { decision: 'deny', actor: 'policy', reason };
}

export function usageToEvent(usage: BudgetUsage): TokenUsage {
  const inputTokens = Math.round(usage.inputTokens);
  const outputTokens = Math.round(usage.outputTokens);
  const total = usage.tokens > 0 ? Math.round(usage.tokens) : inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: total,
    estimated: usage.estimated,
  };
}

export function approvalContext(
  config: ResolvedConfig,
  deps: { interactive: boolean; yolo?: boolean },
): {
  allowlist: AllowlistRule[];
  extraHardDeny: string[];
  timeoutMs: number;
  interactive: boolean;
  yolo: boolean;
} {
  return {
    allowlist: config.approvals.allowlist,
    extraHardDeny: config.approvals.extraHardDeny,
    timeoutMs: config.approvals.timeoutMs,
    interactive: deps.interactive,
    yolo: deps.yolo === true,
  };
}

export function scopeRegistry(registry: ToolRegistry, allowed: string[]): ToolRegistry {
  if (allowed.length === 0) return registry;
  return registry.subset(allowed);
}

export function limitsForPreset(
  config: ResolvedConfig,
  preset: ResolvedConfig['presets'][string] | { kind: 'single'; agent: string },
): Limits {
  const agentName = preset.kind === 'single' ? preset.agent : undefined;
  const agentLimits = agentName ? config.agents[agentName]?.limits : undefined;
  return mergeLimits(DEFAULT_LIMITS, config.limits, agentLimits);
}

export function firstProviderId(config: ResolvedConfig): string {
  const [id] = Object.keys(config.providers);
  if (!id) throw new ConfigError('No providers are configured.');
  return id;
}

export function providerSecretVariables(config: ResolvedConfig): string[] {
  const names: string[] = [];
  for (const provider of Object.values(config.providers)) {
    if ('apiKey' in provider && provider.apiKey) names.push(provider.apiKey.variable);
    if ('headers' in provider && provider.headers) {
      for (const secret of Object.values(provider.headers)) names.push(secret.variable);
    }
  }
  return names;
}

export function extractMultiAgentOutput(result: Record<string, unknown>): string {
  const messages = result['messages'];
  if (Array.isArray(messages) && messages.length > 0) {
    const last = messages[messages.length - 1] as BaseMessage;
    return messageText(last);
  }
  return '';
}

export { resolveWorkspacePath, evaluateApproval, messageToolCalls };
