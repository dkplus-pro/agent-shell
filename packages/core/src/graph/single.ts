import { createHash, randomUUID } from 'node:crypto';
import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  interrupt,
  messagesStateReducer,
  type BaseCheckpointSaver,
} from '@langchain/langgraph';
import type { ApprovalDecision, ApprovalRequest, AllowlistRule } from '../approvals/policy.js';
import { evaluateApproval } from '../approvals/policy.js';
import type { AgentEventSource, AgentEventType, NewEvent, Risk } from '../events/schema.js';
import { truncateText } from '../events/truncate.js';
import { newApprovalId, newSpanId } from '../ids.js';
import { checkBudget, type BudgetUsage, type Limits } from '../limits.js';
import type { ChatModelHandle } from '../providers/types.js';
import type { ToolSourceKind, ToolDefinition } from '../tools/types.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';
import type { ApprovalInterruptAdapter, ToolExecutor } from '../tools/executor.js';
import { toolJsonSchemas } from '../tools/langchain.js';

export interface SingleGraphDeps {
  agentName: string;
  systemPrompt: string;
  handle: ChatModelHandle;
  providerId: string;
  modelId: string;
  registry: ToolRegistry;
  createExecutor: (
    emit: (event: NewEvent<AgentEventType>) => void,
    approval: ApprovalInterruptAdapter,
  ) => ToolExecutor;
  emit: (input: NewEvent<AgentEventType>) => void;
  limits: Limits;
  usage: BudgetUsage;
  ids: { sessionId: string; runId: string; rootSpanId: string };
  approvals: {
    allowlist: AllowlistRule[];
    extraHardDeny: string[];
    timeoutMs: number;
    interactive: boolean;
    yolo: boolean;
  };
  workspaceRoot: string;
  allowOutsideWorkspace: boolean;
  recursionLimit: number;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
}

export const SingleAgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  stepCount: Annotation<number>({ reducer: (_previous, next) => next, default: () => 0 }),
  budgetExceeded: Annotation<string | null>({
    reducer: (_previous, next) => next ?? null,
    default: () => null,
  }),
  lastOutput: Annotation<string>({ reducer: (_previous, next) => next ?? '', default: () => '' }),
});

type SingleAgentStateType = typeof SingleAgentState.State;

interface PendingCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

function pickTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'command', 'cmd', 'url', 'file']) {
    const value = args[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function outcomeOf(call: PendingCall, tool: RegisteredTool | undefined, deps: SingleGraphDeps) {
  return evaluateApproval({
    risk: tool?.risk ?? 'read',
    tool: call.name,
    source: tool?.source ?? 'code',
    args: call.args,
    target: pickTarget(call.args),
    interactive: deps.approvals.interactive,
    yolo: deps.approvals.yolo,
    allowlist: deps.approvals.allowlist,
    extraHardDeny: deps.approvals.extraHardDeny,
    timeoutMs: deps.approvals.timeoutMs,
  });
}

/**
 * Approvals are gathered in a pure pre-pass before any handler touches the world.
 * A node that interrupts is re-executed from its first line by LangGraph, so any
 * side effect placed ahead of an `interrupt()` would run twice — keeping this
 * pass free of effects is what makes exec double-confirmation safe.
 * Decisions are returned in the exact order the executor will ask for them
 * (attempt 1, then attempt 2 for exec) so the adapter can pop without re-deriving.
 */
export function prePassApprovals(
  calls: PendingCall[],
  deps: SingleGraphDeps,
): { decisions: ApprovalDecision[]; ask: (index: number) => void } {
  const decisions: ApprovalDecision[] = [];
  const ask = (_index: number): void => undefined;

  for (const call of calls) {
    const tool = deps.registry.has(call.name) ? deps.registry.get(call.name) : undefined;
    const risk: Risk = tool?.risk ?? 'read';
    const source: ToolSourceKind = tool?.source ?? 'code';
    const outcome = outcomeOf(call, tool, deps);

    if (outcome.kind === 'deny') {
      decisions.push({ decision: 'deny', actor: outcome.actor, reason: outcome.reason });
      continue;
    }
    if (outcome.kind === 'auto-approve') {
      decisions.push({ decision: 'approve', actor: 'policy', reason: outcome.reason });
      continue;
    }

    const approvalId = newApprovalId();
    const request: Omit<ApprovalRequest, 'attempt' | 'spanId'> = {
      approvalId,
      tool: call.name,
      source,
      risk: risk === 'read' ? 'write' : risk,
      argsPreview: call.args,
      runId: deps.ids.runId,
      ...(pickTarget(call.args) === undefined ? {} : { target: pickTarget(call.args) }),
      ...(tool?.description === undefined ? {} : { description: tool.description }),
    };

    const first = interrupt({
      ...request,
      attempt: 1,
      spanId: deps.ids.rootSpanId,
    }) as ApprovalDecision;
    decisions.push(first);
    if (first.decision === 'deny') continue;

    if (risk === 'exec') {
      const second = interrupt({
        ...request,
        attempt: 2,
        spanId: deps.ids.rootSpanId,
      }) as ApprovalDecision;
      decisions.push(second);
      if (second.decision === 'deny' || second.confirmation !== 'run') {
        // The executor will ask twice; overwrite the trailing approve with the real outcome.
        decisions[decisions.length - 2] =
          second.decision === 'deny'
            ? second
            : {
                decision: 'deny',
                actor: second.actor,
                reason: "second confirmation was not 'run'",
              };
      }
    }
  }
  return { decisions, ask };
}

export function buildSingleAgentGraph(
  deps: SingleGraphDeps,
  checkpointer: BaseCheckpointSaver | undefined,
) {
  const modelNode = async (state: SingleAgentStateType): Promise<Partial<SingleAgentStateType>> => {
    const budget = checkBudget(deps.usage, deps.limits);
    if (budget.exceeded && deps.usage.steps > 0) {
      deps.emit({
        type: 'budget.exceeded',
        source: 'runtime',
        sessionId: deps.ids.sessionId,
        runId: deps.ids.runId,
        spanId: deps.ids.rootSpanId,
        payload: {
          kind: budget.kind ?? 'steps',
          limit: budget.limit ?? 0,
          used: budget.used ?? 0,
          agent: deps.agentName,
        },
      });
      return { budgetExceeded: budget.kind ?? 'steps' };
    }

    const spanId = newSpanId();
    const startedAt = Date.now();
    const system: BaseMessage[] =
      deps.systemPrompt.length === 0 ? [] : [new SystemMessage({ content: deps.systemPrompt })];
    const messages = [...system, ...state.messages];
    const tools = deps.registry.list();

    deps.emit({
      type: 'llm.started',
      source: 'provider',
      sessionId: deps.ids.sessionId,
      runId: deps.ids.runId,
      spanId,
      parentSpanId: deps.ids.rootSpanId,
      payload: {
        provider: deps.providerId,
        model: deps.modelId,
        messageCount: messages.length,
        toolCount: tools.length,
        stream: Boolean(deps.onToken),
        agent: deps.agentName,
      },
    });

    try {
      const result = await deps.handle.invoke(messages, {
        tools: toolJsonSchemas(tools),
        ...(deps.signal ? { signal: deps.signal } : {}),
        agent: deps.agentName,
        ...(deps.onToken
          ? {
              streamTokens: (token: string) => {
                deps.onToken?.(token);
              },
            }
          : {}),
      });

      const message = result.message;
      deps.usage.steps += 1;
      deps.usage.tokens += result.usage.totalTokens;
      deps.usage.inputTokens += result.usage.inputTokens;
      deps.usage.outputTokens += result.usage.outputTokens;
      if (!result.usage.estimated) deps.usage.estimated = false;

      const text = messageText(message);
      const preview = truncateText(text);
      deps.emit({
        type: 'llm.completed',
        source: 'provider',
        sessionId: deps.ids.sessionId,
        runId: deps.ids.runId,
        spanId,
        parentSpanId: deps.ids.rootSpanId,
        payload: {
          finishReason: result.finishReason,
          usage: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
            estimated: result.usage.estimated,
          },
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(result.firstTokenMs === undefined ? {} : { firstTokenMs: result.firstTokenMs }),
          outputPreview: preview.text,
          outputTruncated: preview.truncated,
          outputSha256: preview.sha256,
          toolCallCount: messageToolCalls(message).length,
          agent: deps.agentName,
        },
      });

      return {
        messages: [message],
        stepCount: deps.usage.steps,
        lastOutput: text,
        budgetExceeded: null,
      };
    } catch (error) {
      deps.emit({
        type: 'llm.error',
        source: 'provider',
        sessionId: deps.ids.sessionId,
        runId: deps.ids.runId,
        spanId,
        parentSpanId: deps.ids.rootSpanId,
        payload: {
          provider: deps.providerId,
          model: deps.modelId,
          error: { name: errorName(error), message: errorMessage(error) },
        },
      });
      throw error;
    }
  };

  const toolsNode = async (state: SingleAgentStateType): Promise<Partial<SingleAgentStateType>> => {
    const last = state.messages.at(-1);
    const calls: PendingCall[] = messageToolCalls(last).map((call) => ({
      callId: call.id ?? `call_${randomUUID()}`,
      name: call.name ?? '',
      args: (call.args ?? {}) as Record<string, unknown>,
    }));
    if (calls.length === 0) return {};

    const { decisions } = prePassApprovals(calls, deps);
    let cursor = 0;
    const adapter: ApprovalInterruptAdapter = {
      request: () => {
        const decision = decisions[cursor];
        cursor += 1;
        return (
          decision ?? { decision: 'deny', actor: 'policy', reason: 'no pre-pass decision recorded' }
        );
      },
    };

    const spanId = newSpanId();
    const buffered: NewEvent<AgentEventType>[] = [];
    const collect = (event: NewEvent<AgentEventType>): void => {
      buffered.push({ ...event, parentSpanId: event.parentSpanId ?? spanId });
    };
    const executor = deps.createExecutor(collect, adapter);

    const toolMessages: ToolMessage[] = [];
    for (const call of calls) {
      const result = await executor.execute(
        {
          name: call.name,
          args: call.args,
          callId: call.callId,
          parentSpanId: spanId,
          agent: deps.agentName,
        },
        { ...(deps.signal ? { signal: deps.signal } : {}), spanId: newSpanId() },
      );
      toolMessages.push(
        new ToolMessage({
          content: result.content,
          tool_call_id: call.callId,
          name: call.name,
          status: result.isError ? 'error' : 'success',
        }),
      );
    }

    for (const event of buffered) deps.emit(event);
    return { messages: toolMessages };
  };

  const route = (state: SingleAgentStateType): 'tools' | typeof END => {
    if (state.budgetExceeded) return END;
    const last = state.messages.at(-1);
    return messageToolCalls(last).length > 0 ? 'tools' : END;
  };

  const graph = new StateGraph(SingleAgentState)
    .addNode('model', modelNode)
    .addNode('tools', toolsNode)
    .addEdge(START, 'model')
    .addConditionalEdges('model', route, ['tools', END])
    .addEdge('tools', 'model');

  return checkpointer ? graph.compile({ checkpointer }) : graph.compile();
}

export function messageText(message: BaseMessage | undefined): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'string'
          ? block
          : 'text' in block && typeof (block as { text?: unknown }).text === 'string'
            ? String((block as { text: string }).text)
            : JSON.stringify(block),
      )
      .join('');
  }
  return JSON.stringify(content);
}

interface CallLike {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export function messageToolCalls(message: BaseMessage | undefined): CallLike[] {
  if (!message || !AIMessage.isInstance(message)) return [];
  const calls = (message as { tool_calls?: CallLike[] }).tool_calls;
  return Array.isArray(calls) ? calls : [];
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type { AgentEventSource, ToolDefinition };
