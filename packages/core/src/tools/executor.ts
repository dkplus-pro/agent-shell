import { createHash } from 'node:crypto';
import {
  ApprovalDeniedError,
  CancelledError,
  ShellError,
  ToolError,
  ToolTimeoutError,
  ToolValidationError,
  toErrorPayload,
} from '../errors/index.js';
import type { AgentEventSource, AgentEventType, NewEvent, Risk } from '../events/schema.js';
import { evaluateApproval } from '../approvals/policy.js';
import type {
  AllowlistRule,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRisk,
} from '../approvals/policy.js';
import { newApprovalId, newSpanId } from '../ids.js';
import { resolveWorkspacePath } from './path-guard.js';
import type { RegisteredTool, ToolRegistry } from './registry.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  toolOutputToText,
  type ToolContext,
  type ToolOutput,
} from './types.js';

export type { AllowlistRule };

/** Result/preview ceiling for trace and ToolMessage content (docs/01 §5.4, docs/03 §6.3). */
export const DEFAULT_MAX_FIELD_BYTES = 16_384;

/**
 * The graph supplies an adapter whose `request()` calls LangGraph `interrupt()`;
 * tests supply a canned one, which keeps this pipeline graph-agnostic (docs/01 §5.5).
 */
export interface ApprovalInterruptAdapter {
  request(request: ApprovalRequest): ApprovalDecision | Promise<ApprovalDecision>;
}

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  emit: (input: NewEvent<AgentEventType>) => void;
  approval: ApprovalInterruptAdapter;
  approvals: {
    allowlist: AllowlistRule[];
    timeoutMs: number;
    extraHardDeny: string[];
  };
  interactive: boolean;
  yolo: boolean;
  workspaceRoot: string;
  allowOutsideWorkspace: boolean;
  ids: { sessionId: string; runId: string };
  defaultTimeoutMs?: number;
  maxFieldBytes?: number;
  now?: () => number;
}

export interface ToolCall {
  name: string;
  args: unknown;
  callId: string;
  parentSpanId?: string;
  agent?: string;
}

export interface ToolExecutionResult {
  callId: string;
  name: string;
  content: string;
  isError: boolean;
  truncated: boolean;
  sha256: string;
  durationMs: number;
  denied: boolean;
}

export interface ToolExecutorCallOptions {
  signal?: AbortSignal;
  spanId?: string;
}

type HandlerOutcome =
  | { kind: 'ok'; output: ToolOutput }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' };

/**
 * Execution pipeline of docs/01-architecture.md §5.4: validate args -> approval
 * policy -> timeout/abort -> normalize -> events -> ToolMessage content. Every
 * failure path returns an error result instead of rejecting, because the model
 * has to see the failure and get a chance to correct itself (§5.4 step 7).
 */
export class ToolExecutor {
  readonly #deps: ToolExecutorDeps;
  readonly #defaultTimeoutMs: number;
  readonly #maxFieldBytes: number;
  readonly #now: () => number;

  constructor(deps: ToolExecutorDeps) {
    this.#deps = deps;
    this.#defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxFieldBytes = deps.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
    this.#now = deps.now ?? Date.now;
  }

  async execute(call: ToolCall, extra?: ToolExecutorCallOptions): Promise<ToolExecutionResult> {
    const spanId = extra?.spanId ?? newSpanId();
    const startedAt = this.#now();
    let tool: RegisteredTool | undefined;
    try {
      tool = this.#deps.registry.get(call.name);
      const args = this.#validateArgs(tool, call);
      const target = pickTarget(args);
      const preview = this.#preview(args);
      this.#emit('tool.started', 'tool', call, spanId, {
        name: tool.name,
        source: tool.source,
        risk: tool.risk,
        callId: call.callId,
        argsPreview: preview.value,
        argsTruncated: preview.truncated,
        ...(call.agent === undefined ? {} : { agent: call.agent }),
      });
      await this.#authorize(tool, call, spanId, args, target, preview, extra?.signal);
      const output = await this.#invoke(tool, args, call, spanId, extra?.signal);
      return this.#succeed(tool, call, spanId, output, startedAt);
    } catch (error) {
      return this.#fail(call, spanId, tool?.name ?? call.name, error, startedAt);
    }
  }

  #validateArgs(tool: RegisteredTool, call: ToolCall): Record<string, unknown> {
    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      throw new ToolValidationError(call.name, issues);
    }
    return toArgRecord(parsed.data);
  }

  async #authorize(
    tool: RegisteredTool,
    call: ToolCall,
    spanId: string,
    args: Record<string, unknown>,
    target: string | undefined,
    preview: { value: unknown; truncated: boolean },
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const outcome = evaluateApproval({
      risk: tool.risk,
      tool: tool.name,
      source: tool.source,
      args,
      target,
      interactive: this.#deps.interactive,
      yolo: this.#deps.yolo,
      allowlist: this.#deps.approvals.allowlist,
      extraHardDeny: this.#deps.approvals.extraHardDeny,
      timeoutMs: this.#deps.approvals.timeoutMs,
    });

    if (outcome.kind === 'auto-approve') {
      // Reads stay silent; a policy grant is recorded so the trace explains why
      // nothing was asked (docs/01 §5.5).
      if (outcome.reason !== 'read') {
        this.#emitDecided(call, spanId, {
          approvalId: newApprovalId(),
          name: tool.name,
          decision: 'approve',
          actor: 'policy',
          reason: outcome.reason,
        });
      }
      return;
    }

    const approvalId = newApprovalId();
    const risk = approvalRisk(tool.risk, tool.name);
    if (outcome.kind === 'deny') {
      // The request is still recorded: a denial without a trace of what was
      // wanted is unreviewable.
      this.#emit('tool.approval.requested', 'approval', call, spanId, {
        approvalId,
        name: tool.name,
        source: tool.source,
        risk,
        argsPreview: preview.value,
        attempt: 1,
        ...(target === undefined ? {} : { target }),
      });
      this.#emitDecided(call, spanId, {
        approvalId,
        name: tool.name,
        decision: 'deny',
        actor: outcome.actor,
        reason: outcome.reason,
      });
      throw new ApprovalDeniedError(tool.name, outcome.reason);
    }

    for (let attempt = 1; attempt <= outcome.attempts; attempt += 1) {
      const request: ApprovalRequest = {
        approvalId,
        tool: tool.name,
        source: tool.source,
        risk,
        // Approval UIs must show the original arguments, never a summary (§7).
        argsPreview: args,
        attempt: attempt === 1 ? 1 : 2,
        ...(target === undefined ? {} : { target }),
        description: tool.description,
        runId: this.#deps.ids.runId,
        spanId,
      };
      this.#emit('tool.approval.requested', 'approval', call, spanId, {
        approvalId,
        name: tool.name,
        source: tool.source,
        risk,
        argsPreview: preview.value,
        attempt: request.attempt,
        ...(target === undefined ? {} : { target }),
      });
      const decision = await this.#awaitDecision(request, signal);
      this.#emitDecided(call, spanId, {
        approvalId,
        name: tool.name,
        decision: decision.decision,
        actor: decision.actor,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        ...(decision.decision === 'approve' && decision.confirmation !== undefined
          ? { confirmation: decision.confirmation }
          : {}),
      });
      if (decision.decision === 'deny') throw new ApprovalDeniedError(tool.name, decision.reason);
      // exec needs both attempts, and the second must carry the literal "run".
      if (request.attempt === 2 && decision.confirmation !== 'run') {
        throw new ApprovalDeniedError(tool.name, 'second confirmation must be the literal "run"');
      }
    }
  }

  async #awaitDecision(
    request: ApprovalRequest,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalDecision> {
    const timeoutMs = this.#deps.approvals.timeoutMs;
    const pending = Promise.resolve(this.#deps.approval.request(request));
    const waiters: Array<Promise<ApprovalDecision>> = [pending];
    const disposers: Array<() => void> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      waiters.push(
        new Promise<ApprovalDecision>((resolve) => {
          timer = setTimeout(() => {
            resolve({ decision: 'deny', actor: 'policy', reason: `timeout after ${timeoutMs}ms` });
          }, timeoutMs);
        }),
      );
    }
    if (signal !== undefined) {
      waiters.push(
        new Promise<ApprovalDecision>((resolve) => {
          const onAbort = (): void =>
            resolve({ decision: 'deny', actor: 'policy', reason: 'cancelled' });
          if (signal.aborted) onAbort();
          else {
            signal.addEventListener('abort', onAbort, { once: true });
            disposers.push(() => signal.removeEventListener('abort', onAbort));
          }
        }),
      );
    }

    try {
      // `Promise.race` subscribes to every waiter, so a late adapter rejection is
      // never an unhandled one. A timeout or abort is a deny, never an approval.
      return await Promise.race(waiters);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      for (const dispose of disposers) dispose();
    }
  }

  async #invoke(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    call: ToolCall,
    spanId: string,
    signal: AbortSignal | undefined,
  ): Promise<ToolOutput> {
    if (signal?.aborted === true) throw cancelledError(tool.name);
    const controller = new AbortController();
    const timeoutMs = this.#timeoutFor(tool);
    const handler = Promise.resolve().then(() =>
      tool.execute(args as never, this.#context(tool, call, spanId, controller.signal)),
    );
    const outcome = await settleHandler(handler, timeoutMs, controller, signal);
    if (outcome.kind === 'ok') return outcome.output;
    if (outcome.kind === 'failed') throw outcome.error;
    if (outcome.kind === 'timeout') throw new ToolTimeoutError(tool.name, timeoutMs);
    throw cancelledError(tool.name);
  }

  #context(tool: RegisteredTool, call: ToolCall, spanId: string, signal: AbortSignal): ToolContext {
    const workspaceRoot = this.#deps.workspaceRoot;
    const allowOutsideWorkspace = this.#deps.allowOutsideWorkspace;
    return {
      sessionId: this.#deps.ids.sessionId,
      runId: this.#deps.ids.runId,
      spanId,
      callId: call.callId,
      toolName: tool.name,
      signal,
      workspaceRoot,
      allowOutsideWorkspace,
      log: (level, message, fields) =>
        this.#emit('log', 'tool', call, spanId, {
          level,
          message,
          ...(fields === undefined ? {} : { fields }),
        }),
      resolveWorkspacePath: (input: string) =>
        resolveWorkspacePath(input, { workspaceRoot, allowOutsideWorkspace }),
    };
  }

  #succeed(
    tool: RegisteredTool,
    call: ToolCall,
    spanId: string,
    output: ToolOutput,
    startedAt: number,
  ): ToolExecutionResult {
    const durationMs = this.#duration(startedAt);
    const limited = this.#limit(toolOutputToText(output));
    this.#emit('tool.finished', 'tool', call, spanId, {
      name: tool.name,
      callId: call.callId,
      durationMs,
      resultPreview: limited.text,
      truncated: limited.truncated,
      sha256: limited.sha256,
      isError: false,
    });
    return {
      callId: call.callId,
      name: tool.name,
      content: limited.text,
      isError: false,
      truncated: limited.truncated,
      sha256: limited.sha256,
      durationMs,
      denied: false,
    };
  }

  #fail(
    call: ToolCall,
    spanId: string,
    name: string,
    thrown: unknown,
    startedAt: number,
  ): ToolExecutionResult {
    const error = thrown instanceof ShellError ? thrown : new ToolError(describe(thrown), thrown);
    const denied = error instanceof ApprovalDeniedError;
    const limited = this.#limit(denied ? error.message : `Tool "${name}" failed: ${error.message}`);
    this.#emit('tool.error', 'tool', call, spanId, {
      name,
      callId: call.callId,
      error: toErrorPayload(error),
    });
    return {
      callId: call.callId,
      name,
      content: limited.text,
      isError: true,
      truncated: limited.truncated,
      sha256: limited.sha256,
      durationMs: this.#duration(startedAt),
      denied,
    };
  }

  #preview(value: unknown): { value: unknown; truncated: boolean } {
    const text = stringify(value);
    if (Buffer.byteLength(text, 'utf8') <= this.#maxFieldBytes) return { value, truncated: false };
    return { value: truncateToBytes(text, this.#maxFieldBytes), truncated: true };
  }

  #limit(text: string): { text: string; truncated: boolean; sha256: string } {
    // The hash always covers the full payload, so a truncated trace stays verifiable.
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    if (Buffer.byteLength(text, 'utf8') <= this.#maxFieldBytes)
      return { text, truncated: false, sha256 };
    return { text: truncateToBytes(text, this.#maxFieldBytes), truncated: true, sha256 };
  }

  #emitDecided(call: ToolCall, spanId: string, payload: Record<string, unknown>): void {
    this.#emit('tool.approval.decided', 'approval', call, spanId, payload);
  }

  #emit(
    type: AgentEventType,
    source: AgentEventSource,
    call: ToolCall,
    spanId: string,
    payload: Record<string, unknown>,
  ): void {
    this.#deps.emit({
      type,
      source,
      sessionId: this.#deps.ids.sessionId,
      runId: this.#deps.ids.runId,
      spanId,
      ...(call.parentSpanId === undefined ? {} : { parentSpanId: call.parentSpanId }),
      payload,
    });
  }

  #duration(startedAt: number): number {
    return Math.max(0, this.#now() - startedAt);
  }

  /**
   * The registry stamps `DEFAULT_TOOL_TIMEOUT_MS` onto every tool that did not
   * declare one, so an untouched default falls back to the run-level default.
   */
  #timeoutFor(tool: RegisteredTool): number {
    const declared =
      typeof tool.timeoutMs === 'number' && Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0
        ? tool.timeoutMs
        : this.#defaultTimeoutMs;
    return declared === DEFAULT_TOOL_TIMEOUT_MS ? this.#defaultTimeoutMs : declared;
  }
}

/**
 * Races the handler against the deadline and the caller's AbortSignal, then
 * aborts the handler's own signal so nothing keeps running unobserved (§5.4 step 4).
 */
async function settleHandler(
  handler: Promise<ToolOutput>,
  timeoutMs: number,
  controller: AbortController,
  signal: AbortSignal | undefined,
): Promise<HandlerOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => {};
  const racers: Array<Promise<HandlerOutcome>> = [
    handler.then(
      (output): HandlerOutcome => ({ kind: 'ok', output }),
      (error: unknown): HandlerOutcome => ({ kind: 'failed', error }),
    ),
  ];
  if (timeoutMs > 0) {
    racers.push(
      new Promise<HandlerOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      }),
    );
  }
  if (signal !== undefined) {
    racers.push(
      new Promise<HandlerOutcome>((resolve) => {
        const onAbort = (): void => resolve({ kind: 'cancelled' });
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        }
      }),
    );
  }

  let outcome: HandlerOutcome;
  try {
    outcome = await Promise.race(racers);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener();
  }
  controller.abort();
  return outcome;
}

function cancelledError(tool: string): CancelledError {
  return new CancelledError(`Tool "${tool}" was cancelled`);
}

function approvalRisk(risk: Risk, tool: string): ApprovalRisk {
  if (risk === 'write' || risk === 'exec') return risk;
  // read tools are auto-approved by policy, so needing a decision here is a bug.
  throw new ToolError(`Tool "${tool}" is risk "read" but approval was required`);
}

function pickTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ['path', 'command', 'url'] as const) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    return typeof value === 'string' ? value : stringify(value);
  }
  return undefined;
}

function toArgRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Serialising a trace field must never be the reason a tool call fails.
    return String(value);
  }
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function truncateToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}
