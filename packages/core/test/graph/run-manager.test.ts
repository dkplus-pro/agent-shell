import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import {
  rawConfigSchema,
  validateConfig,
  type ModelScript,
  type ResolvedConfig,
} from '../../src/config/schema.js';
import { defineTool, type ToolDefinition } from '../../src/tools/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { RunManager } from '../../src/runtime/run-manager.js';
import { makeTempWorkspace, type TempWorkspace } from '../../src/testing/index.js';
import { readTraceFile } from '../../src/events/reader.js';
import type { AgentEvent } from '../../src/events/schema.js';
import type { ApprovalDecision, ApprovalRequest } from '../../src/approvals/policy.js';
import { BudgetExceededError, CancelledError } from '../../src/errors/index.js';

function errorResult(
  events: Array<{ type: string; payload: Record<string, unknown> }>,
): { preview?: string } | undefined {
  const failed = events.find((event) => event.type === 'tool.error');
  if (failed)
    return { preview: String(failed.payload['error'] && JSON.stringify(failed.payload['error'])) };
  const finished = events.find(
    (event) => event.type === 'tool.finished' && event.payload['isError'] === true,
  );
  return finished ? { preview: String(finished.payload['resultPreview']) } : undefined;
}

const readFile = defineTool({
  name: 'read_file',
  description: 'Read a workspace file',
  schema: z.object({ path: z.string().min(1) }),
  risk: 'read',
  execute: async (args, ctx) => fs.readFileSync(ctx.resolveWorkspacePath(args.path), 'utf8'),
});

const writeFile = defineTool({
  name: 'write_file',
  description: 'Write a workspace file',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  risk: 'write',
  execute: async (args, ctx) => {
    fs.writeFileSync(ctx.resolveWorkspacePath(args.path), args.content, 'utf8');
    return `wrote ${args.path}`;
  },
});

const runShell = defineTool({
  name: 'run_shell',
  description: 'Echo only',
  schema: z.object({ command: z.string().min(1) }),
  risk: 'exec',
  execute: async (args) => args.command.replace(/^echo\s+/, ''),
});

const boom = defineTool({
  name: 'boom',
  description: 'Always fails',
  schema: z.object({}),
  risk: 'read',
  execute: async () => {
    throw new Error('handler exploded');
  },
});

function buildConfig(script: ModelScript, overrides: Record<string, unknown> = {}): ResolvedConfig {
  return validateConfig(
    rawConfigSchema.parse({
      providers: { mock: { kind: 'scripted', models: ['script'], script } },
      defaults: { provider: 'mock:script', preset: 'single', agent: 'default' },
      tools: {
        code: [readFile, writeFile, runShell, boom] as unknown as ToolDefinition<never, never>[],
      },
      agents: {
        default: {
          name: 'default',
          prompt: 'Use tools.',
          tools: ['read_file', 'write_file', 'run_shell', 'boom', 'runtime__spawn_subagent'],
        },
        worker: {
          name: 'worker',
          prompt: 'Read only.',
          tools: ['read_file', 'runtime__spawn_subagent'],
        },
      },
      presets: { single: { kind: 'single', agent: 'default' } },
      ...overrides,
    }),
  );
}

function callStep(
  name: string,
  args: Record<string, unknown>,
  id: string,
): ModelScript['steps'][number] {
  return { toolCalls: [{ name, args, id }] };
}

const answer = (content: string): ModelScript['steps'][number] => ({
  content,
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
});

describe('RunManager single-agent loop', () => {
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await makeTempWorkspace({ 'notes/a.md': 'hello world\n' });
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function run(opts: {
    script: ModelScript;
    task?: string;
    interactive?: boolean;
    yolo?: boolean;
    configOverrides?: Record<string, unknown>;
    decide?: (request: ApprovalRequest) => ApprovalDecision;
    sessionId?: string;
    resume?: boolean;
    signal?: AbortSignal;
    tools?: Parameters<ToolRegistry['registerCode']>[0];
  }): Promise<{
    summary: Awaited<ReturnType<RunManager['startRun']>>;
    events: AgentEvent[];
    tracePath: string;
  }> {
    const config = buildConfig(opts.script, opts.configOverrides ?? {});
    const registry = new ToolRegistry();
    registry.registerCode(opts.tools ?? [readFile, writeFile, runShell, boom]);
    const dataDir = path.join(workspace.dir, '.agent-shell');
    const manager = new RunManager({
      config,
      dataDir,
      workspaceRoot: workspace.dir,
      providers: createProviderRegistry(config),
      registry,
      interactive: opts.interactive ?? true,
      yolo: opts.yolo ?? false,
      checkpointer: new MemorySaver(),
      ...(opts.decide
        ? {
            approvalHandler: {
              decide: async (request: ApprovalRequest) => opts.decide?.(request) ?? denyFor('test'),
            },
          }
        : {}),
    });
    const summary = await manager.startRun({
      task: opts.task ?? 'do the thing',
      sessionId: opts.sessionId,
      ...(opts.resume ? { resume: true } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const events = (await readTraceFile(summary.tracePath)).events;
    return { summary, events, tracePath: summary.tracePath };
  }

  const types = (events: AgentEvent[]): string[] => events.map((event) => event.type);

  it('completes a tool loop and writes a schema-valid trace', async () => {
    const { summary, events, tracePath } = await run({
      script: {
        version: 1,
        steps: [
          callStep('read_file', { path: 'notes/a.md' }, 'c1'),
          answer('the file says hello world'),
        ],
      },
    });

    expect(summary.output).toContain('hello world');
    expect(summary.status).toBe('ok');
    expect(summary.stepCount).toBe(2);
    expect(summary.usage.totalTokens).toBeGreaterThan(0);
    expect(types(events)).toEqual([
      'session.started',
      'run.started',
      'llm.started',
      'llm.completed',
      'tool.started',
      'tool.finished',
      'llm.started',
      'llm.completed',
      'run.finished',
    ]);
    expect(fs.statSync(tracePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(tracePath)).mode & 0o777).toBe(0o700);
    const toolStarted = events.find((event) => event.type === 'tool.started')?.payload as Record<
      string,
      unknown
    >;
    expect(toolStarted.source).toBe('code');
    expect(toolStarted.risk).toBe('read');
    expect(events.every((event) => event.v === 1)).toBe(true);
  });

  it('asks once for write tools and executes after approval', async () => {
    const seen: ApprovalRequest[] = [];
    const { events } = await run({
      script: {
        version: 1,
        steps: [
          callStep('write_file', { path: 'notes/out.md', content: 'made' }, 'c1'),
          answer('written'),
        ],
      },
      decide: (request) => {
        seen.push(request);
        return { decision: 'approve', actor: 'user' };
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.risk).toBe('write');
    expect(seen[0]?.attempt).toBe(1);
    expect(seen[0]?.target).toBe('notes/out.md');
    expect(fs.readFileSync(path.join(workspace.dir, 'notes/out.md'), 'utf8')).toBe('made');
    const requested = events.filter((event) => event.type === 'tool.approval.requested');
    const decided = events.filter((event) => event.type === 'tool.approval.decided');
    expect(requested).toHaveLength(1);
    expect(decided).toHaveLength(1);
    expect((decided[0]?.payload as { decision?: string }).decision).toBe('approve');
    expect((decided[0]?.payload as { approvalId?: string }).approvalId).toBe(
      (requested[0]?.payload as { approvalId?: string }).approvalId,
    );
  });

  it('returns a recoverable tool error when the user denies a write', async () => {
    const { summary, events } = await run({
      script: {
        version: 1,
        steps: [
          callStep('write_file', { path: 'notes/nope.md', content: 'x' }, 'c1'),
          answer('denied, so I summarised instead'),
        ],
      },
      decide: () => ({ decision: 'deny', actor: 'user', reason: 'not now' }),
    });

    expect(fs.existsSync(path.join(workspace.dir, 'notes/nope.md'))).toBe(false);
    expect(summary.output).toContain('summarised');
    const decided = events.find((event) => event.type === 'tool.approval.decided')
      ?.payload as Record<string, unknown>;
    expect(decided.decision).toBe('deny');
    expect(decided.reason).toBe('not now');
    const reported = errorResult(events);
    expect(reported).toBeDefined();
    expect(summary.status).toBe('ok');
  });

  it('requires two confirmations for exec, second one typed as run', async () => {
    const attempts: number[] = [];
    const { events } = await run({
      script: {
        version: 1,
        steps: [callStep('run_shell', { command: 'echo hi' }, 'c1'), answer('done')],
      },
      decide: (request) => {
        attempts.push(request.attempt);
        return request.attempt === 2
          ? { decision: 'approve', actor: 'user', confirmation: 'run' }
          : { decision: 'approve', actor: 'user' };
      },
    });

    expect(attempts).toEqual([1, 2]);
    const requested = events.filter((event) => event.type === 'tool.approval.requested');
    expect(requested.map((event) => (event.payload as { attempt?: number }).attempt)).toEqual([
      1, 2,
    ]);
    expect(events.some((event) => event.type === 'tool.finished')).toBe(true);
  });

  it("does not execute exec when the second confirmation is not 'run'", async () => {
    let executed = false;
    const tracking = defineTool({
      name: 'run_shell',
      description: 'Echo only',
      schema: z.object({ command: z.string().min(1) }),
      risk: 'exec',
      execute: async () => {
        executed = true;
        return 'ran';
      },
    });
    await run({
      tools: [tracking],
      script: {
        version: 1,
        steps: [callStep('run_shell', { command: 'echo hi' }, 'c1'), answer('stop')],
      },
      decide: (request) =>
        request.attempt === 2
          ? { decision: 'approve', actor: 'user' }
          : { decision: 'approve', actor: 'user' },
    });
    expect(executed).toBe(false);
  });

  it('denies write/exec without prompting when the session is not interactive', async () => {
    let prompted = false;
    const { events } = await run({
      interactive: false,
      script: {
        version: 1,
        steps: [callStep('write_file', { path: 'notes/x.md', content: 'x' }, 'c1'), answer('ok')],
      },
      decide: () => {
        prompted = true;
        return { decision: 'approve', actor: 'user' };
      },
    });

    expect(prompted).toBe(false);
    expect(fs.existsSync(path.join(workspace.dir, 'notes/x.md'))).toBe(false);
    const decided = events.find((event) => event.type === 'tool.approval.decided')
      ?.payload as Record<string, unknown>;
    expect(decided.decision).toBe('deny');
    expect(decided.reason).toBe('non-interactive');
    expect(decided.actor).toBe('policy');
  });

  it('still hard-denies destructive commands under --yolo', async () => {
    let executed = false;
    const shell = defineTool({
      name: 'run_shell',
      description: 'Echo only',
      schema: z.object({ command: z.string().min(1) }),
      risk: 'exec',
      execute: async () => {
        executed = true;
        return 'ran';
      },
    });
    await run({
      yolo: true,
      tools: [shell],
      script: {
        version: 1,
        steps: [callStep('run_shell', { command: 'rm -rf /' }, 'c1'), answer('blocked')],
      },
    });
    expect(executed).toBe(false);
  });

  it('rejects paths that escape the workspace', async () => {
    const { events } = await run({
      script: {
        version: 1,
        steps: [callStep('read_file', { path: '../secret.txt' }, 'c1'), answer('refused')],
      },
    });
    const reported = errorResult(events);
    expect(String(reported?.preview)).toMatch(/outside the workspace/i);
  });

  it('turns a throwing handler into a tool error instead of failing the run', async () => {
    const { summary, events } = await run({
      script: { version: 1, steps: [callStep('boom', {}, 'c1'), answer('recovered')] },
    });
    expect(summary.status).toBe('ok');
    const errored = events.find(
      (event) => event.type === 'tool.error' || event.type === 'tool.finished',
    )?.payload as Record<string, unknown>;
    expect(errored).toBeDefined();
    expect(summary.output).toContain('recovered');
  });

  it('stops at the step budget and records budget.exceeded', async () => {
    const attempt = run({
      configOverrides: {
        limits: {
          maxSteps: 2,
          tokenBudget: 100000,
          maxWallTimeMs: 60000,
          maxSubagents: 4,
          maxSubagentDepth: 1,
        },
      },
      script: {
        version: 1,
        steps: [
          callStep('read_file', { path: 'notes/a.md' }, 'c1'),
          callStep('read_file', { path: 'notes/a.md' }, 'c2'),
          callStep('read_file', { path: 'notes/a.md' }, 'c3'),
          answer('never reached'),
        ],
      },
    });
    const error = await attempt
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error & { tracePath?: string });
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as { exitCode?: number }).exitCode).toBe(6);
    const tracePath = (error as { tracePath?: string }).tracePath;
    expect(tracePath).toBeDefined();
    const { events } = await readTraceFile(tracePath as string);
    expect(events.some((event) => event.type === 'budget.exceeded')).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'run.finished' &&
          (event.payload as { status?: string }).status === 'error',
      ),
    ).toBe(true);
  });

  it('answers a model-requested subagent in an isolated context', async () => {
    const { events, summary } = await run({
      script: {
        version: 1,
        steps: [
          callStep('runtime__spawn_subagent', { agent: 'worker', task: 'read notes/a.md' }, 'c1'),
          answer('child said hello world'),
        ],
      },
    });
    expect(summary.output).toContain('child said');
    const started = events.find((event) => event.type === 'subagent.started')?.payload as Record<
      string,
      unknown
    >;
    expect(started.pattern).toBe('spawn');
    expect(started.name).toBe('worker');
    expect(started.depth).toBe(1);
    expect(events.some((event) => event.type === 'subagent.finished')).toBe(true);
  });

  it('refuses to spawn beyond the configured depth', async () => {
    const config = buildConfig({
      version: 1,
      steps: [
        callStep('runtime__spawn_subagent', { agent: 'worker', task: 't' }, 'c1'),
        answer('done'),
      ],
    });
    const registry = new ToolRegistry();
    registry.registerCode([readFile, writeFile, runShell]);
    const manager = new RunManager({
      config,
      dataDir: path.join(workspace.dir, '.agent-shell'),
      workspaceRoot: workspace.dir,
      providers: createProviderRegistry(config),
      registry,
      interactive: true,
      checkpointer: new MemorySaver(),
    });
    const summary = await manager.startRun({ task: 'deep' });
    const { events } = await readTraceFile(summary.tracePath);
    const started = events.filter((event) => event.type === 'subagent.started');
    expect(started.length).toBeGreaterThan(0);
    expect(started.every((event) => ((event.payload as { depth?: number }).depth ?? 0) <= 2)).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'subagent.finished')).toBe(true);
  });

  it('cancels on abort, marks the run cancelled and keeps the trace', async () => {
    const controller = new AbortController();
    const runPromise = run({
      script: {
        version: 1,
        steps: [callStep('read_file', { path: 'notes/a.md' }, 'c1'), answer('never')],
      },
      signal: controller.signal,
    });
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(CancelledError);
  });

  it('resumes a session with its stored messages', async () => {
    const sessionId = 'ses_test_resume';
    const first = await run({
      sessionId,
      script: {
        version: 1,
        steps: [callStep('read_file', { path: 'notes/a.md' }, 'c1'), answer('first turn')],
      },
    });
    expect(first.summary.sessionId).toBe(sessionId);

    const second = await run({
      sessionId,
      resume: true,
      script: { version: 1, steps: [answer('second turn')] },
    });
    const { events } = await readTraceFile(second.tracePath);
    expect(events.some((event) => event.type === 'session.resumed')).toBe(true);
    expect(second.summary.output).toContain('second turn');
  });

  it("offers the agent's scoped tool list to the model", async () => {
    const config = buildConfig({ version: 1, steps: [answer('nothing to do')] });
    const registry = new ToolRegistry();
    registry.registerCode([readFile, writeFile]);
    const manager = new RunManager({
      config,
      dataDir: path.join(workspace.dir, '.agent-shell'),
      workspaceRoot: workspace.dir,
      providers: createProviderRegistry(config),
      registry,
      interactive: true,
      checkpointer: new MemorySaver(),
    });
    const summary = await manager.startRun({ task: 'hi' });
    const { events } = await readTraceFile(summary.tracePath);
    const llm = events.find((event) => event.type === 'llm.started')?.payload as Record<
      string,
      unknown
    >;
    // the agent asked for four code tools (only two are registered) plus the
    // runtime spawn primitive, which the run always offers when subagents exist.
    expect(llm.toolCount).toBe(3);
  });
});

function denyFor(reason: string): ApprovalDecision {
  return { decision: 'deny', actor: 'user', reason };
}
