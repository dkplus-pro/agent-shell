import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  AllowlistRule,
  ApprovalDecision,
  ApprovalRequest,
} from '../../src/approvals/policy.js';
import {
  EVENT_PAYLOAD_SCHEMAS,
  makeEvent,
  validateEvent,
  type AgentEvent,
  type AgentEventType,
  type NewEvent,
} from '../../src/events/schema.js';
import { newRunId, newSessionId, newSpanId } from '../../src/ids.js';
import {
  DEFAULT_MAX_FIELD_BYTES,
  ToolExecutor,
  type ApprovalInterruptAdapter,
  type ToolCall,
  type ToolExecutionResult,
} from '../../src/tools/executor.js';
import { ToolRegistry, type RegistrableTool } from '../../src/tools/registry.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolOutput,
} from '../../src/tools/types.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

interface SetupOptions {
  tools?: RegistrableTool[];
  decisions?: ApprovalDecision[];
  adapter?: ApprovalInterruptAdapter;
  interactive?: boolean;
  yolo?: boolean;
  allowlist?: AllowlistRule[];
  extraHardDeny?: string[];
  approvalTimeoutMs?: number;
  maxFieldBytes?: number;
  defaultTimeoutMs?: number;
  workspaceRoot?: string;
  allowOutsideWorkspace?: boolean;
}

interface Harness {
  registry: ToolRegistry;
  executor: ToolExecutor;
  requests: ApprovalRequest[];
  workspaceRoot: string;
  events(): AgentEvent[];
  types(): AgentEventType[];
  result(partial?: Partial<ToolCall>): Promise<ToolExecutionResult>;
}

let clock = 0;
const baseDir = mkdtempSync(path.join(tmpdir(), 'agent-shell-exec-'));

function setup(options: SetupOptions = {}): Harness {
  const registry = new ToolRegistry();
  registry.registerCode(options.tools ?? []);
  const workspaceRoot = options.workspaceRoot ?? baseDir;
  const raw: Array<NewEvent<AgentEventType>> = [];
  const requests: ApprovalRequest[] = [];
  const queue = [...(options.decisions ?? [])];
  const adapter: ApprovalInterruptAdapter = options.adapter ?? {
    request(request: ApprovalRequest): ApprovalDecision {
      requests.push(request);
      const next = queue.shift();
      if (next !== undefined) return next;
      return request.attempt === 2
        ? { decision: 'approve', actor: 'user', confirmation: 'run' }
        : { decision: 'approve', actor: 'user' };
    },
  };

  const executor = new ToolExecutor({
    registry,
    emit: (event) => {
      raw.push(event);
    },
    approval: adapter,
    approvals: {
      allowlist: options.allowlist ?? [],
      timeoutMs: options.approvalTimeoutMs ?? 0,
      extraHardDeny: options.extraHardDeny ?? [],
    },
    interactive: options.interactive ?? true,
    yolo: options.yolo ?? false,
    workspaceRoot,
    allowOutsideWorkspace: options.allowOutsideWorkspace ?? false,
    ids: { sessionId: newSessionId(), runId: newRunId() },
    defaultTimeoutMs: options.defaultTimeoutMs,
    maxFieldBytes: options.maxFieldBytes,
    now: () => clock,
  });

  const defaultName = registry.names()[0] ?? 'read_file';

  return {
    registry,
    executor,
    requests,
    workspaceRoot,
    events(): AgentEvent[] {
      // Validating through the shared contract asserts strict payload keys.
      return raw.map((event) => validateEvent(makeEvent(event)));
    },
    types: () => raw.map((event) => event.type),
    result: (partial) =>
      executor.execute({
        name: defaultName,
        args: { path: 'docs/a.md' },
        callId: 'call_1',
        ...partial,
      }),
  };
}

function codeTool(
  name: string,
  risk: 'read' | 'write' | 'exec',
  execute: (args: never, ctx: ToolContext) => Promise<ToolOutput>,
  overrides: Partial<RegistrableTool> = {},
): RegistrableTool {
  return {
    name,
    description: `${name} test tool`,
    schema: z.object({
      path: z.string().optional(),
      command: z.string().optional(),
      text: z.string().optional(),
    }),
    risk,
    execute,
    ...overrides,
  };
}

function ranTool(ran: { value: boolean }, output: ToolOutput = 'done'): RegistrableTool {
  return codeTool('write_file', 'write', async () => {
    ran.value = true;
    return output;
  });
}

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return { name: 'read_file', args: { path: 'docs/a.md' }, callId: 'call_1', ...overrides };
}

beforeEach(() => {
  clock = 1_000;
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('ToolExecutor happy path', () => {
  it('runs a read tool without approval events and emits started + finished', async () => {
    const ran = { value: false };
    const h = setup({
      tools: [
        codeTool('read_file', 'read', async () => {
          ran.value = true;
          clock += 7;
          return 'file body';
        }),
      ],
    });
    const result = await h.result({});

    expect(ran.value).toBe(true);
    expect(h.types()).toEqual(['tool.started', 'tool.finished']);
    expect(result).toMatchObject({
      callId: 'call_1',
      name: 'read_file',
      content: 'file body',
      isError: false,
      truncated: false,
      denied: false,
      durationMs: 7,
    });
    expect(result.sha256).toBe(sha256('file body'));
  });

  it('emits the exact tool.started and tool.finished payload keys', async () => {
    const parent = newSpanId();
    const span = newSpanId();
    const h = setup({ tools: [codeTool('read_file', 'read', async () => 'x')] });
    await h.executor.execute(
      { ...call(), agent: 'writer', parentSpanId: parent },
      { spanId: span },
    );

    const [started, finished] = h.events();
    expect(Object.keys(started!.payload).sort()).toEqual([
      'agent',
      'argsPreview',
      'argsTruncated',
      'callId',
      'name',
      'risk',
      'source',
    ]);
    expect(started!.payload).toMatchObject({
      name: 'read_file',
      source: 'code',
      risk: 'read',
      callId: 'call_1',
      agent: 'writer',
      argsTruncated: false,
    });
    expect(started!.payload['argsPreview']).toEqual({ path: 'docs/a.md' });
    expect(Object.keys(finished!.payload).sort()).toEqual([
      'callId',
      'durationMs',
      'isError',
      'name',
      'resultPreview',
      'sha256',
      'truncated',
    ]);
    expect(finished!.spanId).toBe(span);
    expect(finished!.parentSpanId).toBe(parent);
    expect(h.events().every((event) => event.source === 'tool')).toBe(true);
  });

  it('normalises structured output to text', async () => {
    const h = setup({
      tools: [codeTool('read_file', 'read', async () => ({ lines: [1, 2], ok: true }))],
    });
    const result = await h.result({});
    expect(result.content).toBe('{"lines":[1,2],"ok":true}');
    expect(result.sha256).toBe(sha256(result.content));
  });

  it('passes a complete ToolContext with a bound path guard and debug log', async () => {
    let seen: ToolContext | undefined;
    const h = setup({
      tools: [
        codeTool('read_file', 'read', async (_args: never, ctx: ToolContext) => {
          seen = ctx;
          ctx.log('debug', 'reading', { path: 'a' });
          return ctx.resolveWorkspacePath('docs/a.md');
        }),
      ],
    });
    const span = newSpanId();
    const result = await h.executor.execute(call(), { spanId: span });

    expect(seen).toBeDefined();
    expect(result.content).toBe(path.join(h.workspaceRoot, 'docs', 'a.md'));
    expect(seen!.sessionId).toBe(h.events()[0]!.sessionId);
    expect(seen!.runId).toBe(h.events()[0]!.runId);
    expect(seen!.spanId).toBe(span);
    expect(seen!.callId).toBe('call_1');
    expect(seen!.toolName).toBe('read_file');
    expect(seen!.workspaceRoot).toBe(h.workspaceRoot);
    expect(seen!.allowOutsideWorkspace).toBe(false);
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    expect(typeof seen!.resolveWorkspacePath).toBe('function');

    expect(h.types()).toEqual(['tool.started', 'log', 'tool.finished']);
    const log = h.events()[1]!;
    expect(log.source).toBe('tool');
    expect(Object.keys(log.payload).sort()).toEqual(['fields', 'level', 'message']);
    expect(log.payload).toEqual({ level: 'debug', message: 'reading', fields: { path: 'a' } });
  });

  it('rejects a workspace escape performed by the handler', async () => {
    const h = setup({
      tools: [
        codeTool('read_file', 'read', async (_a: never, ctx: ToolContext) =>
          ctx.resolveWorkspacePath('../secret'),
        ),
      ],
    });
    const result = await h.result({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the workspace/);
    expect(h.events().at(-1)!.payload['error']).toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('lets the handler escape the workspace when allowOutsideWorkspace is set', async () => {
    const h = setup({
      allowOutsideWorkspace: true,
      tools: [
        codeTool('read_file', 'read', async (_a: never, ctx: ToolContext) =>
          ctx.resolveWorkspacePath('../secret'),
        ),
      ],
    });
    // The guard returns the resolved outside path; assert the real value rather
    // than a hardcoded /tmp (os.tmpdir() is environment-dependent).
    const expected = path.resolve(realpathSync(h.workspaceRoot), '..', 'secret');
    await expect(h.result({})).resolves.toMatchObject({ content: expected, isError: false });
  });
});

describe('ToolExecutor argument validation', () => {
  it('returns an error result for unknown tools without throwing', async () => {
    const h = setup();
    const result = await h.result({ name: 'nope' });
    expect(h.types()).toEqual(['tool.error']);
    expect(result).toMatchObject({ name: 'nope', isError: true, denied: false });
    expect(result.content).toMatch(/Unknown tool "nope"/);
    expect(h.events()[0]!.payload['error']).toMatchObject({
      code: 'TOOL_NOT_FOUND',
      name: 'UnknownToolError',
    });
  });

  it('returns an error result when zod validation fails', async () => {
    const h = setup({
      tools: [
        {
          ...codeTool('read_file', 'read', async () => 'unreachable'),
          schema: z.object({ path: z.string().min(1) }),
        },
      ],
    });
    const result = await h.result({ args: { path: 42 } });
    expect(h.types()).toEqual(['tool.error']);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid arguments/);
    expect(h.events()[0]!.payload['error']).toMatchObject({
      code: 'TOOL_VALIDATION',
      name: 'ToolValidationError',
    });
    expect(Object.keys(h.events()[0]!.payload).sort()).toEqual(['callId', 'error', 'name']);
  });

  it('passes the validated (not raw) arguments to the handler', async () => {
    let received: Record<string, unknown> | undefined;
    const h = setup({
      tools: [
        {
          ...codeTool('read_file', 'read', async (args: never) => {
            received = args as unknown as Record<string, unknown>;
            return 'ok';
          }),
          schema: z.object({ path: z.string(), extra: z.string().default('fallback') }),
        },
      ],
    });
    await h.result({ args: { path: 'a.md' } });
    expect(received).toEqual({ path: 'a.md', extra: 'fallback' });
  });
});

describe('ToolExecutor approval matrix', () => {
  it('write: user approval is asked once and recorded with the user actor', async () => {
    const ran = { value: false };
    const h = setup({ tools: [ranTool(ran)] });
    const result = await h.result({});

    expect(ran.value).toBe(true);
    expect(result.isError).toBe(false);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.finished',
    ]);
    const requested = h.events()[1]!;
    const decided = h.events()[2]!;
    expect(requested.source).toBe('approval');
    expect(Object.keys(requested.payload).sort()).toEqual([
      'approvalId',
      'argsPreview',
      'attempt',
      'name',
      'risk',
      'source',
      'target',
    ]);
    expect(requested.payload).toMatchObject({
      name: 'write_file',
      source: 'code',
      risk: 'write',
      attempt: 1,
      target: 'docs/a.md',
    });
    expect(Object.keys(decided.payload).sort()).toEqual([
      'actor',
      'approvalId',
      'decision',
      'name',
    ]);
    expect(decided.payload).toMatchObject({ decision: 'approve', actor: 'user' });
    expect(decided.payload['approvalId']).toBe(requested.payload['approvalId']);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.tool).toBe('write_file');
    expect(h.requests[0]!.target).toBe('docs/a.md');
    expect(h.requests[0]!.argsPreview).toEqual({ path: 'docs/a.md' });
  });

  it('write: a user denial blocks the handler and is reported as denied', async () => {
    const ran = { value: false };
    const h = setup({
      tools: [ranTool(ran)],
      decisions: [{ decision: 'deny', actor: 'user', reason: 'not now' }],
    });
    const result = await h.result({});
    expect(ran.value).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.denied).toBe(true);
    expect(result.content).toMatch(/not now/);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.error',
    ]);
    expect(h.events()[2]!.payload).toMatchObject({
      decision: 'deny',
      actor: 'user',
      reason: 'not now',
    });
    expect(h.events()[3]!.payload['error']).toMatchObject({ code: 'APPROVAL_DENIED' });
  });

  it('write: a script actor decision is recorded verbatim', async () => {
    const h = setup({
      tools: [ranTool({ value: false })],
      decisions: [{ decision: 'approve', actor: 'script', reason: 'policy says yes' }],
    });
    await h.result({});
    expect(h.events()[2]!.payload).toMatchObject({
      decision: 'approve',
      actor: 'script',
      reason: 'policy says yes',
    });
  });

  it('write: approval timeout is a deny', async () => {
    const ran = { value: false };
    const h = setup({
      tools: [ranTool(ran)],
      approvalTimeoutMs: 20,
      adapter: { request: () => new Promise<ApprovalDecision>(() => {}) },
    });
    const result = await h.result({});
    expect(ran.value).toBe(false);
    expect(result.denied).toBe(true);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.error',
    ]);
    expect(h.events()[2]!.payload).toMatchObject({ decision: 'deny', actor: 'policy' });
    expect(String(h.events()[2]!.payload['reason'])).toMatch(/timeout after 20ms/);
  });

  it('write: non-interactive refuses without asking', async () => {
    const ran = { value: false };
    const h = setup({ tools: [ranTool(ran)], interactive: false });
    const result = await h.result({});
    expect(ran.value).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(result.denied).toBe(true);
    expect(result.content).toMatch(/non-interactive/);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.error',
    ]);
    expect(h.events()[2]!.payload).toMatchObject({
      decision: 'deny',
      actor: 'policy',
      reason: 'non-interactive',
    });
  });

  it('write: an allowlist match auto-approves and records why', async () => {
    const h = setup({
      tools: [ranTool({ value: false })],
      allowlist: [{ tool: 'write_file', argsMatch: { path: 'docs/a.md' } }],
    });
    const result = await h.result({});
    expect(result.isError).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(h.types()).toEqual(['tool.started', 'tool.approval.decided', 'tool.finished']);
    expect(h.events()[1]!.payload).toMatchObject({
      decision: 'approve',
      actor: 'policy',
      reason: 'allowlist',
    });
  });

  it('an allowlist that does not match the args still asks', async () => {
    const h = setup({
      tools: [ranTool({ value: false })],
      allowlist: [{ tool: 'write_file', argsMatch: { path: 'other.md' } }],
    });
    await h.result({});
    expect(h.requests).toHaveLength(1);
    expect(h.types()[1]).toBe('tool.approval.requested');
  });

  it('write: --yolo auto-approves with a policy trace entry', async () => {
    const h = setup({ tools: [ranTool({ value: false })], yolo: true, interactive: false });
    const result = await h.result({});
    expect(result.isError).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(h.types()).toEqual(['tool.started', 'tool.approval.decided', 'tool.finished']);
    expect(h.events()[1]!.payload).toMatchObject({
      decision: 'approve',
      actor: 'policy',
      reason: 'yolo',
    });
  });

  it('exec requires two attempts and the literal run confirmation', async () => {
    const ran = { value: false };
    const h = setup({
      tools: [
        {
          ...codeTool('write_file', 'exec', async () => {
            ran.value = true;
            return 'ok';
          }),
        },
      ],
    });
    const result = await h.executor.execute({
      name: 'write_file',
      args: { command: 'ls -la' },
      callId: 'call_2',
    });
    expect(ran.value).toBe(true);
    expect(result.isError).toBe(false);
    expect(h.requests.map((request) => request.attempt)).toEqual([1, 2]);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.finished',
    ]);
    const events = h.events();
    expect(events[1]!.payload).toMatchObject({ attempt: 1, risk: 'exec', target: 'ls -la' });
    expect(events[3]!.payload).toMatchObject({ attempt: 2, risk: 'exec', target: 'ls -la' });
    expect(events[1]!.payload['approvalId']).toBe(events[3]!.payload['approvalId']);
    expect(events[4]!.payload).toMatchObject({ decision: 'approve', confirmation: 'run' });
    expect(Object.keys(events[4]!.payload).sort()).toEqual([
      'actor',
      'approvalId',
      'confirmation',
      'decision',
      'name',
    ]);
  });

  it('exec is denied when the second attempt lacks the run confirmation', async () => {
    const ran = { value: false };
    const h = setup({
      tools: [
        codeTool('write_file', 'exec', async () => {
          ran.value = true;
          return 'ok';
        }),
      ],
      decisions: [
        { decision: 'approve', actor: 'user' },
        { decision: 'approve', actor: 'user' },
      ],
    });
    const result = await h.executor.execute({
      name: 'write_file',
      args: { command: 'ls' },
      callId: 'call_2',
    });
    expect(ran.value).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.content).toMatch(/second confirmation/);
    expect(h.types().filter((type) => type === 'tool.approval.requested')).toHaveLength(2);
  });

  it('exec is denied when the first attempt refuses', async () => {
    const h = setup({
      tools: [codeTool('write_file', 'exec', async () => 'never')],
      decisions: [{ decision: 'deny', actor: 'user', reason: 'too risky' }],
    });
    const result = await h.executor.execute({
      name: 'write_file',
      args: { command: 'ls' },
      callId: 'call_2',
    });
    expect(result.denied).toBe(true);
    expect(h.requests).toHaveLength(1);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.error',
    ]);
  });

  it('hard-deny still blocks under --yolo', async () => {
    const ran = { value: false };
    const h = setup({
      yolo: true,
      tools: [
        codeTool('write_file', 'exec', async () => {
          ran.value = true;
          return 'rm -rf /';
        }),
      ],
    });
    const result = await h.executor.execute({
      name: 'write_file',
      args: { command: 'rm -rf /' },
      callId: 'call_2',
    });
    expect(ran.value).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(result.denied).toBe(true);
    expect(result.content).toMatch(/hard-deny/);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.error',
    ]);
    expect(h.events()[2]!.payload).toMatchObject({ decision: 'deny', actor: 'policy' });
    expect(String(h.events()[2]!.payload['reason'])).toMatch(/hard-deny: rm -rf \//);
  });

  it('extraHardDeny extends the net for write tools too', async () => {
    const h = setup({
      tools: [ranTool({ value: false })],
      extraHardDeny: ['docs/secret.md'],
      interactive: false,
    });
    const result = await h.result({ args: { path: 'docs/secret.md' } });
    expect(result.denied).toBe(true);
    // hard-deny only guards exec risk, so a write tool falls back to non-interactive.
    expect(String(result.content)).toMatch(/non-interactive/);
    const execHarness = setup({
      tools: [codeTool('write_file', 'exec', async () => 'ok')],
      extraHardDeny: ['drop table'],
    });
    const denied = await execHarness.executor.execute({
      name: 'write_file',
      args: { command: 'DROP TABLE users' },
      callId: 'c',
    });
    expect(denied.denied).toBe(true);
    expect(String(denied.content)).toMatch(/hard-deny: drop table/);
  });

  it('read tools never raise approval events, even non-interactive', async () => {
    const h = setup({
      interactive: false,
      tools: [codeTool('read_file', 'read', async () => 'content')],
    });
    const result = await h.result({});
    expect(result.isError).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(h.types()).toEqual(['tool.started', 'tool.finished']);
  });
});

describe('ToolExecutor timeouts and cancellation', () => {
  function slowTool(ms: number, output: ToolOutput = 'late'): RegistrableTool {
    return codeTool(
      'read_file',
      'read',
      () =>
        new Promise<ToolOutput>((resolve) => {
          setTimeout(() => resolve(output), ms);
        }),
      { timeoutMs: 20 },
    );
  }

  it('emits a tool.error with TOOL_TIMEOUT when the handler is too slow', async () => {
    const h = setup({ tools: [slowTool(500)] });
    const result = await h.result({});
    expect(result.isError).toBe(true);
    expect(result.denied).toBe(false);
    expect(result.content).toMatch(/timed out after 20ms/);
    expect(h.types()).toEqual(['tool.started', 'tool.error']);
    expect(h.events()[1]!.payload['error']).toMatchObject({
      code: 'TOOL_TIMEOUT',
      name: 'ToolTimeoutError',
    });
  });

  it('applies the run-level default timeout to tools that declared none', async () => {
    const noDeclaredTimeout = codeTool(
      'read_file',
      'read',
      () => new Promise<ToolOutput>(() => {}),
    );
    const h = setup({ tools: [noDeclaredTimeout], defaultTimeoutMs: 15 });
    const result = await h.result({});
    expect(result.content).toMatch(/timed out after 15ms/);
  });

  it('keeps a tool-declared timeout ahead of the run default', async () => {
    const h = setup({ tools: [slowTool(500)], defaultTimeoutMs: 5_000 });
    const result = await h.result({});
    expect(result.content).toMatch(/timed out after 20ms/);
  });

  it('aborts the handler signal when the deadline wins', async () => {
    let aborted = false;
    const h = setup({
      tools: [
        codeTool(
          'read_file',
          'read',
          (_args: never, ctx: ToolContext) =>
            new Promise<ToolOutput>((resolve) => {
              ctx.signal.addEventListener('abort', () => {
                aborted = true;
              });
              setTimeout(() => resolve('never used'), 5_000);
            }),
          { timeoutMs: 10 },
        ),
      ],
    });
    const result = await h.result({});
    expect(result.isError).toBe(true);
    expect(aborted).toBe(true);
  });

  it('refuses to start a handler when the signal is already aborted', async () => {
    const ran = { value: false };
    const h = setup({
      tools: [codeTool('read_file', 'read', async () => ((ran.value = true), 'x'))],
    });
    const controller = new AbortController();
    controller.abort();
    const result = await h.executor.execute(call(), { signal: controller.signal });
    expect(ran.value).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.denied).toBe(false);
    expect(result.content).toMatch(/was cancelled/);
    expect(h.types()).toEqual(['tool.started', 'tool.error']);
    expect(h.events()[1]!.payload['error']).toMatchObject({
      name: 'CancelledError',
      code: 'CANCELLED',
    });
  });

  it('returns a cancelled error result when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const h = setup({
      tools: [
        codeTool(
          'read_file',
          'read',
          (_args: never, ctx: ToolContext) =>
            new Promise<ToolOutput>((resolve, reject) => {
              const timer = setTimeout(() => resolve('late'), 5_000);
              ctx.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('handler aborted'));
              });
            }),
          { timeoutMs: DEFAULT_TOOL_TIMEOUT_MS },
        ),
      ],
    });
    const pending = h.executor.execute(call(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/was cancelled/);
    expect(h.types()).toEqual(['tool.started', 'tool.error']);
  });

  it('treats an abort during approval as a deny', async () => {
    const ran = { value: false };
    const controller = new AbortSignalTest();
    const h = setup({
      tools: [ranTool(ran)],
      adapter: { request: () => new Promise<ApprovalDecision>(() => {}) },
    });
    // ranTool registers "write_file"; an approval only happens for a write/exec
    // tool, so the call must target it (not the harness default "read_file").
    const pending = h.executor.execute(call({ name: 'write_file' }), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const result = await pending;
    expect(ran.value).toBe(false);
    expect(result.denied).toBe(true);
    expect(h.types()).toEqual([
      'tool.started',
      'tool.approval.requested',
      'tool.approval.decided',
      'tool.error',
    ]);
    expect(h.events()[2]!.payload).toMatchObject({
      decision: 'deny',
      actor: 'policy',
      reason: 'cancelled',
    });
  });
});

describe('ToolExecutor failure isolation', () => {
  it('converts a thrown Error into an error ToolMessage without rejecting', async () => {
    const h = setup({
      tools: [
        codeTool('read_file', 'read', async () => {
          throw new Error('disk on fire');
        }),
      ],
    });
    const result = await h.result({});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Tool "read_file" failed: disk on fire/);
    expect(result.sha256).toBe(sha256(result.content));
    expect(h.types()).toEqual(['tool.started', 'tool.error']);
    expect(h.events()[1]!.payload['error']).toMatchObject({
      name: 'ToolError',
      code: 'TOOL_EXECUTION',
    });
  });

  it('wraps non-Error throwables', async () => {
    const h = setup({
      tools: [
        codeTool('read_file', 'read', async () => {
          throw 'just a string';
        }),
      ],
    });
    const result = await h.result({});
    expect(result.content).toMatch(/just a string/);
    expect(h.events()[1]!.payload['error']).toMatchObject({ name: 'ToolError' });
  });

  it('keeps shell error taxonomy from the handler', async () => {
    const h = setup({
      tools: [
        codeTool('read_file', 'read', async () => {
          const { ToolError } = await import('../../src/errors/index.js');
          throw new ToolError('cannot write');
        }),
      ],
    });
    const result = await h.result({});
    expect(result.content).toMatch(/Tool "read_file" failed: cannot write/);
    expect(h.events()[1]!.payload['error']).toMatchObject({
      name: 'ToolError',
      code: 'TOOL_EXECUTION',
    });
  });

  it('records the parent span and a generated tool span by default', async () => {
    const h = setup({ tools: [codeTool('read_file', 'read', async () => 'x')] });
    await h.executor.execute(call({ parentSpanId: newSpanId() }));
    const events = h.events();
    expect(events[0]!.spanId).toMatch(/^spn_/);
    expect(events[0]!.spanId).toBe(events[1]!.spanId);
    expect(events.every((event) => /^ses_/.test(event.sessionId))).toBe(true);
    expect(events.every((event) => /^run_/.test(event.runId))).toBe(true);
  });
});

describe('ToolExecutor result limits', () => {
  it('truncates by bytes, flags it and hashes the full payload', async () => {
    const full = 'é'.repeat(100);
    const h = setup({
      tools: [codeTool('read_file', 'read', async () => full)],
      maxFieldBytes: 32,
    });
    const result = await h.result({});
    expect(result.truncated).toBe(true);
    expect(result.content).toBe('é'.repeat(16));
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(32);
    expect(result.sha256).toBe(sha256(full));
    const finished = h.events()[1]!;
    expect(finished.payload).toMatchObject({
      truncated: true,
      sha256: sha256(full),
      isError: false,
    });
    expect(finished.payload['resultPreview']).toBe('é'.repeat(16));
  });

  it('uses the 16 KB default and does not truncate below it', async () => {
    expect(DEFAULT_MAX_FIELD_BYTES).toBe(16_384);
    const exact = 'a'.repeat(DEFAULT_TOOL_TIMEOUT_MS * 10 + DEFAULT_MAX_FIELD_BYTES);
    const h = setup({ tools: [codeTool('read_file', 'read', async () => exact)] });
    const result = await h.result({});
    expect(result.content).toBe(exact.slice(0, DEFAULT_MAX_FIELD_BYTES));
    expect(result.truncated).toBe(true);
    expect(result.sha256).toBe(sha256(exact));
  });

  it('truncates oversized args in tool.started', async () => {
    const h = setup({
      maxFieldBytes: 16,
      tools: [codeTool('read_file', 'read', async () => 'ok')],
    });
    await h.result({ args: { path: 'x'.repeat(200) } });
    const started = h.events()[0]!;
    expect(started.payload['argsTruncated']).toBe(true);
    expect(typeof started.payload['argsPreview']).toBe('string');
    expect(String(started.payload['argsPreview']).length).toBeLessThanOrEqual(16);
  });

  it('truncates a very long error message and hashes the original', async () => {
    const h = setup({
      maxFieldBytes: 24,
      tools: [
        codeTool('read_file', 'read', async () => {
          throw new Error('e'.repeat(500));
        }),
      ],
    });
    const result = await h.result({});
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBe(24);
    expect(result.sha256).toBe(sha256(`Tool "read_file" failed: ${'e'.repeat(500)}`));
  });
});

describe('ToolExecutor event payload contracts', () => {
  it('emits payloads that satisfy the strict event schema v1 for every path', async () => {
    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      risk: 'read' | 'write' | 'exec';
    }> = [
      { name: 'read_file', args: { path: 'docs/a.md' }, risk: 'read' },
      { name: 'write_file', args: { path: 'docs/a.md' }, risk: 'write' },
      { name: 'run_shell', args: { command: 'ls' }, risk: 'exec' },
    ];
    for (const item of cases) {
      const h = setup({
        tools: cases.map((entry) =>
          codeTool(entry.name, entry.risk, async () => `${entry.name} output`),
        ),
      });
      await h.executor.execute({ name: item.name, args: item.args, callId: `call_${item.name}` });
      const events = h.events();
      const schemaKeys = (type: AgentEventType): string[] =>
        Object.keys((EVENT_PAYLOAD_SCHEMAS[type] as z.ZodObject).shape);
      for (const event of events) {
        const payloadKeys = Object.keys(event.payload);
        expect(payloadKeys.every((key) => schemaKeys(event.type).includes(key))).toBe(true);
        for (const key of schemaKeys(event.type)) {
          if (payloadKeys.includes(key)) continue;
          const optional = (EVENT_PAYLOAD_SCHEMAS[event.type] as z.ZodObject).shape[key];
          expect(optional).toBeDefined();
        }
      }
      // read -> 0 approvals, write -> 1, exec -> 2 (docs/01 §5.5: the second must
      // be the literal "run", so exec emits two requested/decided pairs).
      const approvalEvents =
        item.risk === 'read'
          ? []
          : item.risk === 'exec'
            ? [
                'tool.approval.requested',
                'tool.approval.decided',
                'tool.approval.requested',
                'tool.approval.decided',
              ]
            : ['tool.approval.requested', 'tool.approval.decided'];
      expect(events.map((event) => event.type)).toEqual([
        'tool.started',
        ...approvalEvents,
        'tool.finished',
      ]);
    }
  });
});

class AbortSignalTest {
  readonly controller = new AbortController();
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  abort(): void {
    this.controller.abort();
  }
}
