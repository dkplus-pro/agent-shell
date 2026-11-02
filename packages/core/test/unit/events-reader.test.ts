import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newEventId, newRunId, newSessionId, newSpanId } from '../../src/ids.js';
import {
  buildSpanTree,
  listRuns,
  readTraceFile,
  renderSpanTree,
  summarizeRun,
  tailTrace,
} from '../../src/events/reader.js';
import {
  makeEvent,
  type AgentEvent,
  type AgentEventSource,
  type AgentEventType,
} from '../../src/events/schema.js';

const SESSION = newSessionId();
const RUN = newRunId();
const ROOT = newSpanId();
const NODE = newSpanId();
const LLM = newSpanId();
const TOOL = newSpanId();
const SUB = newSpanId();
const SUB_LLM = newSpanId();
const APPROVAL = newSpanId();
const READ = newSpanId();

type Seed = {
  type: AgentEventType;
  ts: string;
  payload: Record<string, unknown>;
  spanId: string;
  parentSpanId?: string;
  source?: AgentEventSource;
  runId?: string;
};

function traceEvent(seed: Seed): AgentEvent {
  return makeEvent({
    id: newEventId(),
    ts: seed.ts,
    sessionId: SESSION,
    runId: seed.runId ?? RUN,
    spanId: seed.spanId,
    ...(seed.parentSpanId === undefined ? {} : { parentSpanId: seed.parentSpanId }),
    source: seed.source ?? 'runtime',
    type: seed.type,
    payload: seed.payload,
  });
}

const usage = (inputTokens: number, outputTokens: number): Record<string, unknown> => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

function llmCompleted(
  spanId: string,
  parentSpanId: string,
  ts: string,
  tokens: [number, number],
  preview: string,
): Seed {
  return {
    type: 'llm.completed',
    ts,
    spanId,
    parentSpanId,
    source: 'provider',
    payload: {
      finishReason: 'stop',
      usage: usage(tokens[0], tokens[1]),
      durationMs: 1_000,
      outputPreview: preview,
      outputTruncated: false,
      outputSha256: 'cc',
    },
  };
}

function runSeeds(): Seed[] {
  return [
    {
      type: 'run.started',
      ts: '2026-11-03T12:00:00.000Z',
      spanId: ROOT,
      payload: {
        inputPreview: 'read notes',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        preset: 'single',
      },
    },
    {
      type: 'graph.node.started',
      ts: '2026-11-03T12:00:00.010Z',
      spanId: NODE,
      parentSpanId: ROOT,
      source: 'graph',
      payload: { node: 'agent', step: 1 },
    },
    {
      type: 'graph.node.finished',
      ts: '2026-11-03T12:00:00.020Z',
      spanId: NODE,
      parentSpanId: ROOT,
      source: 'graph',
      payload: { node: 'agent', durationMs: 400 },
    },
    {
      type: 'llm.started',
      ts: '2026-11-03T12:00:01.100Z',
      spanId: LLM,
      parentSpanId: ROOT,
      source: 'provider',
      payload: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        messageCount: 2,
        toolCount: 1,
        stream: true,
      },
    },
    {
      type: 'llm.completed',
      ts: '2026-11-03T12:00:01.200Z',
      spanId: LLM,
      parentSpanId: ROOT,
      source: 'provider',
      payload: {
        finishReason: 'tool_calls',
        usage: usage(620, 180),
        durationMs: 1_200,
        outputPreview: 'calling write_file',
        outputTruncated: false,
        outputSha256: 'aa',
      },
    },
    {
      type: 'tool.started',
      ts: '2026-11-03T12:00:02.300Z',
      spanId: TOOL,
      parentSpanId: ROOT,
      source: 'tool',
      payload: {
        name: 'write_file',
        source: 'code',
        risk: 'write',
        callId: 'call_1',
        argsPreview: { path: 'notes/a.md' },
        argsTruncated: false,
      },
    },
    {
      type: 'tool.approval.requested',
      ts: '2026-11-03T12:00:02.301Z',
      spanId: TOOL,
      parentSpanId: ROOT,
      source: 'approval',
      payload: {
        approvalId: 'apr_1',
        name: 'write_file',
        source: 'code',
        risk: 'write',
        argsPreview: { path: 'notes/a.md' },
        attempt: 1,
      },
    },
    {
      type: 'tool.approval.decided',
      ts: '2026-11-03T12:00:02.400Z',
      spanId: TOOL,
      parentSpanId: ROOT,
      source: 'approval',
      payload: { approvalId: 'apr_1', name: 'write_file', decision: 'approve', actor: 'user' },
    },
    {
      type: 'tool.finished',
      ts: '2026-11-03T12:00:02.412Z',
      spanId: TOOL,
      parentSpanId: ROOT,
      source: 'tool',
      payload: {
        name: 'write_file',
        callId: 'call_1',
        durationMs: 12,
        resultPreview: 'wrote 1.2KB',
        truncated: false,
        sha256: 'bb',
        isError: false,
      },
    },
    {
      type: 'subagent.started',
      ts: '2026-11-03T12:00:03.500Z',
      spanId: SUB,
      parentSpanId: ROOT,
      source: 'subagent',
      payload: { pattern: 'spawn', name: 'researcher', depth: 1, taskPreview: 'summarise' },
    },
    {
      type: 'llm.started',
      ts: '2026-11-03T12:00:03.590Z',
      spanId: SUB_LLM,
      parentSpanId: SUB,
      source: 'provider',
      payload: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        messageCount: 1,
        toolCount: 0,
        stream: false,
      },
    },
    llmCompleted(SUB_LLM, SUB, '2026-11-03T12:00:03.600Z', [300, 90], 'done'),
    {
      type: 'tool.approval.requested',
      ts: '2026-11-03T12:00:03.610Z',
      spanId: APPROVAL,
      parentSpanId: SUB,
      source: 'approval',
      payload: {
        approvalId: 'apr_2',
        name: 'run_shell',
        source: 'code',
        risk: 'exec',
        argsPreview: { command: 'ls' },
        attempt: 1,
      },
    },
    {
      type: 'tool.approval.decided',
      ts: '2026-11-03T12:00:03.620Z',
      spanId: APPROVAL,
      parentSpanId: SUB,
      source: 'approval',
      payload: {
        approvalId: 'apr_2',
        name: 'run_shell',
        decision: 'deny',
        actor: 'policy',
        reason: 'hard-deny',
      },
    },
    {
      type: 'subagent.finished',
      ts: '2026-11-03T12:00:03.700Z',
      spanId: SUB,
      parentSpanId: ROOT,
      source: 'subagent',
      payload: {
        pattern: 'spawn',
        name: 'researcher',
        status: 'ok',
        durationMs: 2_800,
        usage: usage(300, 90),
      },
    },
    {
      type: 'tool.started',
      ts: '2026-11-03T12:00:03.800Z',
      spanId: READ,
      parentSpanId: ROOT,
      source: 'tool',
      payload: {
        name: 'read_file',
        source: 'code',
        risk: 'read',
        callId: 'call_2',
        argsPreview: { path: 'notes/a.md' },
        argsTruncated: false,
      },
    },
    {
      type: 'tool.finished',
      ts: '2026-11-03T12:00:03.805Z',
      spanId: READ,
      parentSpanId: ROOT,
      source: 'tool',
      payload: {
        name: 'read_file',
        callId: 'call_2',
        durationMs: 5,
        resultPreview: '# notes',
        truncated: false,
        sha256: 'dd',
        isError: false,
      },
    },
    {
      type: 'log',
      ts: '2026-11-03T12:00:03.710Z',
      spanId: ROOT,
      payload: { level: 'debug', message: 'trace map' },
    },
    {
      type: 'run.finished',
      ts: '2026-11-03T12:00:04.200Z',
      spanId: ROOT,
      payload: {
        status: 'ok',
        durationMs: 4_200,
        usage: usage(620, 180),
        stepCount: 3,
        subagentCount: 1,
      },
    },
  ];
}

function runTrace(): AgentEvent[] {
  return runSeeds().map((seed) => traceEvent(seed));
}

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-shell-reader-'));
  dirs.push(dir);
  return dir;
}

async function writeTrace(path: string, events: AgentEvent[]): Promise<void> {
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readTraceFile', () => {
  it('reads every line back as a validated event', async () => {
    const root = await tempDir();
    const path = join(root, 'run_ok.jsonl');
    const events = runTrace();
    await writeTrace(path, events);

    const trace = await readTraceFile(path);
    expect(trace.warnings).toEqual([]);
    expect(trace.events).toHaveLength(events.length);
    expect(trace.events[0]?.runId).toBe(RUN);
    expect(trace.events.map((event) => event.type)).toContain('subagent.finished');
  });

  it('skips a corrupt trailing line with a warning instead of throwing', async () => {
    const root = await tempDir();
    const path = join(root, 'run_partial.jsonl');
    const events = runTrace();
    const body = events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(path, `${body}\n{"v":1,"id":"evt_`, 'utf8');

    const trace = await readTraceFile(path);
    expect(trace.events).toHaveLength(events.length);
    expect(trace.warnings).toHaveLength(1);
    expect(trace.warnings[0]).toContain(`line ${events.length + 1}`);
    expect(trace.warnings[0]).toContain('trailing partial line');
  });

  it('reports a corrupt line in the middle and keeps reading', async () => {
    const root = await tempDir();
    const path = join(root, 'run_middle.jsonl');
    const lines = runTrace().map((event) => JSON.stringify(event));
    lines.splice(3, 0, '{ not json');
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');

    const trace = await readTraceFile(path);
    expect(trace.events).toHaveLength(lines.length - 1);
    expect(trace.warnings).toEqual([expect.stringContaining('line 4')]);
  });

  it('warns when a line parses but violates schema v1', async () => {
    const root = await tempDir();
    const path = join(root, 'run_drift.jsonl');
    const first = runSeeds()[0];
    if (first === undefined) throw new Error('expected a seed');
    const bad = traceEvent({ ...first, payload: { ...first.payload, unexpected: 1 } });
    await writeFile(path, `${JSON.stringify(bad)}\n`, 'utf8');

    const trace = await readTraceFile(path);
    expect(trace.events).toEqual([]);
    expect(trace.warnings[0]).toContain('line 1');
    expect(trace.warnings[0]).toContain('unexpected');
  });

  it('accepts an empty trace and rejects a missing file loudly', async () => {
    const root = await tempDir();
    const empty = join(root, 'run_empty.jsonl');
    await writeFile(empty, '', 'utf8');
    expect(await readTraceFile(empty)).toEqual({ events: [], warnings: [] });
    await expect(readTraceFile(join(root, 'absent.jsonl'))).rejects.toThrow();
  });
});

describe('buildSpanTree', () => {
  it('nests by parentSpanId and orders siblings by ts regardless of input order', () => {
    const tree = buildSpanTree(runTrace().reverse());

    expect(tree).toHaveLength(1);
    const root = tree[0];
    if (root === undefined) throw new Error('expected a root span');
    expect(root.spanId).toBe(ROOT);
    expect(root.kind).toBe('run');
    expect(root.label).toBe('openai:gpt-4.1-mini');
    expect(root.startedAt).toBe('2026-11-03T12:00:00.000Z');
    expect(root.endedAt).toBe('2026-11-03T12:00:04.200Z');
    expect(root.durationMs).toBe(4_200);
    expect(root.meta.status).toBe('ok');
    expect(root.meta.usage?.totalTokens).toBe(800);
    expect(root.children.map((child) => child.spanId)).toEqual([NODE, LLM, TOOL, SUB, READ]);
    expect(root.events.map((event) => event.type)).toEqual(['run.started', 'log', 'run.finished']);

    const tool = root.children[2];
    expect(tool?.kind).toBe('tool');
    expect(tool?.label).toBe('write_file');
    expect(tool?.meta).toEqual({ risk: 'write', source: 'code', approvalDecision: 'approve' });
    expect(tool?.durationMs).toBe(12);

    const sub = root.children[3];
    expect(sub?.kind).toBe('subagent');
    expect(sub?.meta.pattern).toBe('spawn');
    expect(sub?.meta.depth).toBe(1);
    expect(sub?.meta.status).toBe('ok');
    expect(sub?.durationMs).toBe(2_800);
    expect(sub?.children.map((child) => child.spanId)).toEqual([SUB_LLM, APPROVAL]);

    const approval = sub?.children[1];
    expect(approval?.kind).toBe('approval');
    expect(approval?.label).toBe('run_shell');
    expect(approval?.meta.approvalDecision).toBe('deny');
  });

  it('is deterministic for siblings sharing a timestamp', () => {
    const spanB = `spn_${'b'.repeat(36)}`;
    const spanA = `spn_${'a'.repeat(36)}`;
    const events = [
      traceEvent(runSeeds()[0] as Seed),
      traceEvent({
        type: 'llm.started',
        ts: '2026-11-03T12:00:01.000Z',
        spanId: spanB,
        parentSpanId: ROOT,
        source: 'provider',
        payload: {
          provider: 'openai',
          model: 'b-model',
          messageCount: 1,
          toolCount: 0,
          stream: false,
        },
      }),
      traceEvent({
        type: 'llm.started',
        ts: '2026-11-03T12:00:01.000Z',
        spanId: spanA,
        parentSpanId: ROOT,
        source: 'provider',
        payload: {
          provider: 'openai',
          model: 'a-model',
          messageCount: 1,
          toolCount: 0,
          stream: false,
        },
      }),
    ];

    const first = buildSpanTree(events)[0]?.children.map((child) => child.spanId);
    const second = buildSpanTree([...events].reverse())[0]?.children.map((child) => child.spanId);
    expect(first).toEqual([spanA, spanB]);
    expect(second).toEqual(first);
  });

  it('treats spans with an unknown parent as roots and breaks parent cycles', () => {
    const orphan = buildSpanTree([
      traceEvent({
        type: 'tool.started',
        ts: '2026-11-03T12:00:00.000Z',
        spanId: TOOL,
        parentSpanId: newSpanId(),
        source: 'tool',
        payload: {
          name: 'x',
          source: 'code',
          risk: 'read',
          callId: 'c',
          argsPreview: {},
          argsTruncated: false,
        },
      }),
    ]);
    expect(orphan).toHaveLength(1);

    const parentA = `spn_${'1'.repeat(36)}`;
    const parentB = `spn_${'2'.repeat(36)}`;
    const cyclic = buildSpanTree([
      traceEvent({
        type: 'tool.started',
        ts: '2026-11-03T12:00:00.000Z',
        spanId: parentA,
        parentSpanId: parentB,
        source: 'tool',
        payload: {
          name: 'a',
          source: 'code',
          risk: 'read',
          callId: 'c',
          argsPreview: {},
          argsTruncated: false,
        },
      }),
      traceEvent({
        type: 'tool.started',
        ts: '2026-11-03T12:00:00.100Z',
        spanId: parentB,
        parentSpanId: parentA,
        source: 'tool',
        payload: {
          name: 'b',
          source: 'code',
          risk: 'read',
          callId: 'c',
          argsPreview: {},
          argsTruncated: false,
        },
      }),
    ]);
    expect(cyclic.map((node) => node.spanId).sort()).toEqual([parentA, parentB].sort());
    // Top-level spans carry no connector, exactly like `trace show` renders the run.
    expect(renderSpanTree(cyclic)).toEqual([
      'tool a  [read · code]  0ms  ok',
      'tool b  [read · code]  0ms  ok',
    ]);
  });

  it('marks a truncated or failed tool result in meta', () => {
    const tree = buildSpanTree([
      traceEvent({
        type: 'tool.finished',
        ts: '2026-11-03T12:00:00.000Z',
        spanId: TOOL,
        source: 'tool',
        payload: {
          name: 'read_file',
          callId: 'c',
          durationMs: 3,
          resultPreview: 'cut',
          truncated: true,
          sha256: 'ff',
          isError: true,
        },
      }),
    ]);
    expect(tree[0]?.meta.truncated).toBe(true);
    expect(tree[0]?.meta.isError).toBe(true);
  });
});

describe('renderSpanTree', () => {
  it('renders the tree with box-drawing connectors and durations', () => {
    const lines = renderSpanTree(buildSpanTree(runTrace()));
    expect(lines[0]).toBe(`${RUN.slice(0, 8)}...  ok  4.2s  openai:gpt-4.1-mini  tokens=800`);
    expect(lines.slice(1)).toEqual([
      '├─ node agent  400ms',
      '├─ llm gpt-4.1-mini  1.2s  620/180',
      '├─ tool write_file  [write · code · approval=approve]  12ms  ok',
      '├─ subagent spawn researcher  depth=1  2.8s  ok',
      '│  ├─ llm gpt-4.1-mini  1.0s  300/90',
      '│  └─ approval run_shell  deny',
      '└─ tool read_file  [read · code]  5ms  ok',
    ]);
    expect(lines.filter((line) => line.includes('trace map'))).toHaveLength(0);
  });

  it('renders log events of a span as children when verbose', () => {
    const lines = renderSpanTree(buildSpanTree(runTrace()), { verbose: true });
    expect(lines[1]).toBe('├─ log  debug  trace map');
    expect(lines[2]).toBe('├─ node agent  400ms');
  });

  it('hides a log-only span unless verbose', () => {
    const logsOnly = [
      traceEvent({
        type: 'log',
        ts: '2026-11-03T12:00:00.000Z',
        spanId: LLM,
        payload: { level: 'debug', message: 'langchain run map' },
      }),
    ];
    expect(renderSpanTree(buildSpanTree(logsOnly))).toEqual([]);
    expect(renderSpanTree(buildSpanTree(logsOnly), { verbose: true })).toEqual([
      'log  debug  langchain run map',
    ]);
  });

  it('renders spans whose parent is missing in the same file as extra roots', () => {
    const events = runTrace().filter(
      (event) => event.spanId !== ROOT && event.parentSpanId !== ROOT,
    );
    const lines = renderSpanTree(buildSpanTree(events));
    expect(lines).toEqual(['llm gpt-4.1-mini  1.0s  300/90', 'approval run_shell  deny']);
  });
});

describe('summarizeRun', () => {
  it('prefers run.finished fields over counted fallbacks', () => {
    expect(summarizeRun(runTrace())).toEqual({
      runId: RUN,
      sessionId: SESSION,
      startedAt: '2026-11-03T12:00:00.000Z',
      status: 'ok',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      durationMs: 4_200,
      totalTokens: 800,
      stepCount: 3,
      approvalCount: 2,
      subagentCount: 1,
      tracePath: '',
    });
  });

  it('reports error status and derived counters when run.finished is missing', () => {
    const summary = summarizeRun(runTrace().filter((event) => event.type !== 'run.finished'));
    expect(summary.status).toBe('error');
    expect(summary.durationMs).toBe(3_805);
    expect(summary.stepCount).toBe(1);
    expect(summary.subagentCount).toBe(1);
    expect(summary.totalTokens).toBe(1_580);
    expect(summary.approvalCount).toBe(2);
  });

  it('falls back to unknown provider and model without run.started', () => {
    const summary = summarizeRun(runTrace().filter((event) => event.type !== 'run.started'));
    expect(summary.provider).toBe('unknown');
    expect(summary.model).toBe('unknown');
    expect(summary.startedAt).toBe('2026-11-03T12:00:00.010Z');
    expect(summary.status).toBe('ok');
    expect(summary.durationMs).toBe(4_200);
  });

  it('refuses to summarize an empty trace', () => {
    expect(() => summarizeRun([])).toThrow(/no events/);
  });
});

describe('listRuns', () => {
  it('scans ses_*/run_*.jsonl newest first and skips unreadable entries', async () => {
    const root = await tempDir();
    const traces = join(root, 'traces');
    const older = newRunId();
    const newer = newRunId();
    await mkdir(join(traces, SESSION), { recursive: true });
    await writeTrace(
      join(traces, SESSION, `${older}.jsonl`),
      runTrace().map((event) => ({ ...event, runId: older })),
    );
    await writeTrace(join(traces, SESSION, `${newer}.jsonl`), [
      traceEvent({
        runId: newer,
        type: 'run.started',
        ts: '2026-11-04T09:00:00.000Z',
        spanId: ROOT,
        payload: {
          inputPreview: 'later',
          provider: 'anthropic',
          model: 'claude',
          preset: 'single',
        },
      }),
    ]);
    await writeFile(join(traces, SESSION, 'run_empty.jsonl'), '', 'utf8');
    await writeFile(join(traces, SESSION, 'notes.txt'), 'ignore me', 'utf8');
    await writeFile(join(traces, SESSION, 'run_broken.jsonl'), '{ truncated\n', 'utf8');
    await mkdir(join(traces, 'not_a_session'));
    await writeFile(join(traces, 'not_a_session', 'run_x.jsonl'), '{}\n', 'utf8');
    await mkdir(join(traces, SESSION, 'run_dir.jsonl'));

    const runs = await listRuns(traces);
    expect(runs.map((run) => run.runId)).toEqual([newer, older]);
    expect(runs[0]?.startedAt).toBe('2026-11-04T09:00:00.000Z');
    expect(runs[0]?.status).toBe('error');
    expect(runs[1]?.status).toBe('ok');
    expect(runs[1]?.tracePath).toBe(join(traces, SESSION, `${older}.jsonl`));

    expect(await listRuns(traces, SESSION)).toHaveLength(2);
    expect(await listRuns(traces, 'ses_absent')).toEqual([]);
    expect(await listRuns(join(root, 'absent'))).toEqual([]);
    await expect(listRuns(traces, '../outside')).rejects.toThrow(/Invalid session id/);
  });

  it('agrees with summarizeRun for a single run file', async () => {
    const root = await tempDir();
    const traces = join(root, 'traces');
    await mkdir(join(traces, SESSION), { recursive: true });
    await writeTrace(join(traces, SESSION, `${RUN}.jsonl`), runTrace());

    const [entry] = await listRuns(traces);
    if (entry === undefined) throw new Error('expected the run to be listed');
    expect({ ...entry, tracePath: '' }).toEqual(summarizeRun(runTrace()));
    expect(entry.tracePath).toBe(join(traces, SESSION, `${RUN}.jsonl`));
  });
});

describe('tailTrace', () => {
  it('replays existing lines and follows appends until aborted', async () => {
    const root = await tempDir();
    const path = join(root, 'run_tail.jsonl');
    await writeTrace(path, runTrace().slice(0, 2));

    const seen: string[] = [];
    const controller = new AbortController();
    const tailing = tailTrace(
      path,
      (event) => seen.push(`${event.type}:${String(event.payload['message'] ?? '')}`),
      controller.signal,
    );
    await vi.waitFor(() => expect(seen).toEqual(['run.started:', 'graph.node.started:']), {
      timeout: 2_000,
    });

    const appended = traceEvent({
      type: 'log',
      ts: '2026-11-03T12:00:05.000Z',
      spanId: ROOT,
      payload: { level: 'info', message: 'appended' },
    });
    const line = `${JSON.stringify(appended)}\n`;
    await writeFile(path, line.slice(0, 40), { encoding: 'utf8', flag: 'a' });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    expect(seen).toHaveLength(2);

    await writeFile(path, line.slice(40), { encoding: 'utf8', flag: 'a' });
    await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 2_000 });
    expect(seen[2]).toBe('log:appended');

    controller.abort();
    await tailing;
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('returns promptly when the signal is already aborted', async () => {
    const root = await tempDir();
    const path = join(root, 'run_done.jsonl');
    await writeTrace(path, runTrace().slice(0, 1));

    const controller = new AbortController();
    controller.abort();
    const seen: AgentEvent[] = [];
    await tailTrace(path, (event) => seen.push(event), controller.signal);
    expect(seen).toEqual([]);
  });

  it('fails loudly when the trace file is missing', async () => {
    const root = await tempDir();
    await expect(
      tailTrace(join(root, 'absent.jsonl'), () => {}, new AbortController().signal),
    ).rejects.toThrow();
  });
});
