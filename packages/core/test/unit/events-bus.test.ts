import { mkdtemp, readFile, rm, stat, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventSink } from '../../src/events/bus.js';
import { EventBus, InMemorySink } from '../../src/events/bus.js';
import { ConsoleSink, JsonlFileSink } from '../../src/events/sinks.js';
import { listRuns, readTraceFile } from '../../src/events/reader.js';
import { sha256Hex } from '../../src/events/truncate.js';
import {
  EVENT_TYPES,
  validateEvent,
  type AgentEvent,
  type AgentEventSource,
  type AgentEventType,
  type NewEvent,
} from '../../src/events/schema.js';
import { newRunId, newSessionId, newSpanId } from '../../src/ids.js';

const SESSION = newSessionId();
const RUN = newRunId();
const ROOT = newSpanId();

function input(
  type: AgentEventType,
  payload: Record<string, unknown>,
  opts: { spanId?: string; parentSpanId?: string; source?: AgentEventSource; ts?: string } = {},
): NewEvent<AgentEventType> {
  return {
    type,
    sessionId: SESSION,
    runId: RUN,
    spanId: opts.spanId ?? ROOT,
    ...(opts.parentSpanId === undefined ? {} : { parentSpanId: opts.parentSpanId }),
    source: opts.source ?? 'runtime',
    ...(opts.ts === undefined ? {} : { ts: opts.ts }),
    payload,
  };
}

function makeEventObject(type: AgentEventType, payload: Record<string, unknown>): AgentEvent {
  const event: AgentEvent = {
    v: 1,
    id: `evt_${'0'.repeat(36)}`,
    ts: '2026-11-03T12:00:00.000Z',
    sessionId: SESSION,
    runId: RUN,
    spanId: ROOT,
    type,
    source: 'runtime',
    payload,
  };
  validateEvent(event);
  return event;
}

const toolStarted = (preview: unknown): Record<string, unknown> => ({
  name: 'run_shell',
  source: 'code',
  risk: 'exec',
  callId: 'call_1',
  argsPreview: preview,
  argsTruncated: false,
});

const runStarted = (preview: string): Record<string, unknown> => ({
  inputPreview: preview,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  preset: 'single',
});

class RecorderSink implements EventSink {
  readonly written: AgentEvent[][] = [];
  closed = false;

  constructor(readonly name: string) {}

  write(events: AgentEvent[]): void {
    if (this.closed) throw new Error(`${this.name} written after close`);
    this.written.push([...events]);
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ThrowingSink implements EventSink {
  writes = 0;

  constructor(
    readonly name: string,
    private readonly failure: unknown,
  ) {}

  async write(events: AgentEvent[]): Promise<void> {
    this.writes += 1;
    if (events.length > 0) throw this.failure;
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

const tempDirs: string[] = [];

class BufferingFailingSink implements EventSink {
  readonly name = 'buffering';

  write(_events: AgentEvent[]): void {
    /* kept in the sink until flush */
  }

  async flush(): Promise<void> {
    throw new Error('buffer not flushed');
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-shell-events-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.UNIT_BUS_TOKEN;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('EventBus', () => {
  it('buffers events and only writes them on an async drain', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0 });
    const started = bus.emit(input('run.started', runStarted('hi')));

    expect(bus.count()).toBe(1);
    expect(sink.events).toEqual([]);
    expect(started.v).toBe(1);
    expect(started.id).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(started.sessionId).toBe(SESSION);

    await bus.flush();
    expect(sink.events).toEqual([started]);

    expect(bus.emitRaw(started)).toBe(started);
    expect(bus.count()).toBe(2);
    await bus.close();
  });

  it('auto-flushes at the batch threshold and on the periodic timer', async () => {
    const batchSink = new InMemorySink();
    const batchBus = new EventBus({ sinks: [batchSink], batchSize: 2, flushIntervalMs: 0 });
    batchBus.emit(input('log', { level: 'info', message: 'one' }));
    expect(batchSink.events).toHaveLength(0);
    batchBus.emit(input('log', { level: 'info', message: 'two' }));
    await vi.waitFor(() => expect(batchSink.events).toHaveLength(2));
    await batchBus.close();

    const timerSink = new InMemorySink();
    const timerBus = new EventBus({ sinks: [timerSink], batchSize: 1_000, flushIntervalMs: 5 });
    timerBus.emit(input('log', { level: 'info', message: 'tick' }));
    await vi.waitFor(() => expect(timerSink.events).toHaveLength(1));
    await timerBus.close();
  });

  it('redacts nested secrets and records a trace.redaction count event', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0, redaction: {} });
    const emitted = bus.emit(
      input('tool.started', toolStarted({ command: 'echo', api_key: 'sk-live-123456' })),
    );

    expect(JSON.stringify(emitted)).not.toContain('sk-live-123456');
    await bus.close();

    expect(sink.events.map((event) => event.type)).toEqual(['tool.started', 'trace.redaction']);
    expect(sink.events[1]?.payload).toEqual({ fieldsRedacted: 1 });
    expect(sink.events[1]?.runId).toBe(RUN);
    const recorded = sink.events[0];
    if (recorded === undefined) throw new Error('expected a recorded event');
    expect(() => validateEvent(recorded)).not.toThrow();
    expect(JSON.stringify(recorded.payload)).toContain('[redacted]');
  });

  it('scrubs credential values from the environment even with no redaction options', async () => {
    process.env.UNIT_BUS_TOKEN = 'env-secret-value';
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0 });
    bus.emit(
      input('log', {
        level: 'info',
        message: 'env-secret-value',
        fields: { note: 'env-secret-value', kept: 1 },
      }),
    );
    await bus.close();

    expect(JSON.stringify(sink.events)).not.toContain('env-secret-value');
    expect(sink.events.find((event) => event.type === 'log')?.payload['message']).toBe(
      '[redacted]',
    );
    expect(sink.events.find((event) => event.type === 'trace.redaction')?.payload).toEqual({
      fieldsRedacted: 2,
    });
  });

  it('truncates a long tool result and keeps the sha256 of the original', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0 });
    const full = 'log line\n'.repeat(4_000);
    const emitted = bus.emit(
      input('tool.finished', {
        name: 'read_file',
        callId: 'call_1',
        durationMs: 12,
        resultPreview: full,
        truncated: false,
        sha256: 'stale',
        isError: false,
      }),
    );

    const preview = String(emitted.payload['resultPreview']);
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(16_384);
    expect(emitted.payload['truncated']).toBe(true);
    expect(emitted.payload['sha256']).toBe(sha256Hex(full));
    expect(emitted.payload['sha256']).not.toBe(sha256Hex(preview));

    await bus.close();
    const recorded = sink.events.find((event) => event.type === 'tool.finished');
    if (recorded === undefined) throw new Error('expected the tool result to be recorded');
    expect(() => validateEvent(recorded)).not.toThrow();
  });

  it('truncates llm output previews and rewrites the output hash', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0, maxFieldBytes: 256 });
    const output = 'z'.repeat(4_000);
    const emitted = bus.emit(
      input(
        'llm.completed',
        {
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          durationMs: 90,
          outputPreview: output,
          outputTruncated: false,
          outputSha256: 'stale',
        },
        { source: 'provider' },
      ),
    );

    expect(emitted.payload['outputTruncated']).toBe(true);
    expect(emitted.payload['outputSha256']).toBe(sha256Hex(output));
    expect(Buffer.byteLength(String(emitted.payload['outputPreview']), 'utf8')).toBeLessThanOrEqual(
      256,
    );
    await bus.close();
    const recorded = sink.events[0];
    if (recorded === undefined) throw new Error('expected a recorded event');
    expect(() => validateEvent(recorded)).not.toThrow();
  });

  it('caps run input preview at 2 KB and keeps small structured args by reference', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0 });
    const started = bus.emit(input('run.started', runStarted('q'.repeat(5_000))));
    expect(Buffer.byteLength(String(started.payload['inputPreview']), 'utf8')).toBeLessThanOrEqual(
      2_048,
    );

    const args = { path: 'notes/a.md', content: 'short' };
    const toolEvent = bus.emit(input('tool.started', toolStarted(args)));
    expect(toolEvent.payload['argsPreview']).toBe(args);
    expect(toolEvent.payload['argsTruncated']).toBe(false);
    await bus.close();
  });

  it('never invents payload keys, so strict schema validation still passes', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0, maxFieldBytes: 64 });
    bus.emit(input('tool.started', toolStarted({ command: 'ls -la '.repeat(200) })));
    bus.emit(input('run.started', runStarted('w'.repeat(3_000))));
    await bus.close();

    const tool = sink.events.find((event) => event.type === 'tool.started');
    expect(Object.keys(tool?.payload ?? {}).sort()).toEqual(
      ['argsPreview', 'argsTruncated', 'callId', 'name', 'risk', 'source'].sort(),
    );
    expect(tool?.payload['argsTruncated']).toBe(true);
    for (const event of sink.events) expect(() => validateEvent(event)).not.toThrow();
  });

  it('truncates error messages to 4 KB without dropping other fields', async () => {
    const sink = new InMemorySink();
    const bus = new EventBus({ sinks: [sink], flushIntervalMs: 0 });
    const emitted = bus.emit(
      input('run.error', {
        error: { name: 'ProviderError', code: 'PROVIDER_NETWORK', message: 'e'.repeat(9_000) },
      }),
    );
    const error = emitted.payload['error'];
    if (typeof error !== 'object' || error === null) throw new Error('expected an error payload');
    const message = (error as { message: unknown }).message;
    expect(Buffer.byteLength(String(message), 'utf8')).toBeLessThanOrEqual(4_096);
    await bus.close();
    const recorded = sink.events[0];
    if (recorded === undefined) throw new Error('expected a recorded event');
    expect(() => validateEvent(recorded)).not.toThrow();
  });

  it('keeps other sinks alive when one throws and reports the failure on close', async () => {
    const healthy = new InMemorySink();
    const failing = new ThrowingSink('broken-disk', new Error('disk full'));
    const bus = new EventBus({ sinks: [failing, healthy], flushIntervalMs: 0 });

    bus.emit(input('log', { level: 'info', message: 'first' }));
    bus.emit(input('log', { level: 'info', message: 'second' }));
    await bus.flush();

    expect(failing.writes).toBeGreaterThan(0);
    expect(healthy.events.map((event) => event.payload['message'])).toEqual(['first', 'second']);
    expect(bus.sinkErrors.map((error) => error.message)).toEqual(['disk full']);

    await expect(bus.close()).rejects.toThrow('disk full');
    expect(healthy.events).toHaveLength(2);
    expect(bus.sinkErrors).toHaveLength(1);
  });

  it('wraps a non-Error sink failure with the sink name', async () => {
    const bus = new EventBus({ sinks: [new ThrowingSink('noisy', 'kaboom')], flushIntervalMs: 0 });
    bus.emit(input('log', { level: 'info', message: 'hello' }));
    await bus.flush();
    expect(bus.sinkErrors[0]?.message).toContain('noisy');
    await expect(bus.close()).rejects.toThrow(/noisy/);
  });

  it('surfaces a sink that buffers and only fails on flush', async () => {
    const bus = new EventBus({ sinks: [new BufferingFailingSink()], flushIntervalMs: 0 });
    bus.emit(input('log', { level: 'info', message: 'hi' }));

    await bus.flush();
    expect(bus.sinkErrors.map((error) => error.message)).toEqual(['buffer not flushed']);
    await expect(bus.close()).rejects.toThrow('buffer not flushed');
  });

  it('flushes and closes every sink, then rejects further emits', async () => {
    const probe = new RecorderSink('probe');
    const bus = new EventBus({ sinks: [probe], batchSize: 1_000, flushIntervalMs: 0 });
    bus.emit(input('log', { level: 'info', message: 'buffered' }));

    await bus.close();

    expect(probe.closed).toBe(true);
    expect(probe.written.flat().map((event) => event.payload['message'])).toEqual(['buffered']);
    expect(() => bus.emit(input('log', { level: 'info', message: 'late' }))).toThrow(/closed/);
  });

  it('delivers one batch per drain so sinks can amortise writes', async () => {
    const probe = new RecorderSink('batched');
    const bus = new EventBus({ sinks: [probe], batchSize: 1_000, flushIntervalMs: 0 });
    for (let index = 0; index < 5; index += 1)
      bus.emit(input('log', { level: 'info', message: `m${index}` }));
    await bus.flush();
    expect(probe.written).toHaveLength(1);
    expect(probe.written[0]).toHaveLength(5);
    await bus.close();
  });

  it('writes an append-only trace the reader can replay', async () => {
    const root = await tempDir();
    const filePath = join(root, 'traces', SESSION, `${RUN}.jsonl`);
    const bus = new EventBus({ sinks: [new JsonlFileSink(filePath)], flushIntervalMs: 0 });

    bus.emit(input('run.started', runStarted('read notes/a.md')));
    bus.emit(
      input(
        'run.finished',
        {
          status: 'ok',
          durationMs: 4_200,
          usage: { inputTokens: 620, outputTokens: 180, totalTokens: 800 },
          stepCount: 1,
          subagentCount: 0,
        },
        { ts: '2026-11-03T12:00:04.200Z' },
      ),
    );
    await bus.close();

    const trace = await readTraceFile(filePath);
    expect(trace.events.map((event) => event.type)).toEqual(['run.started', 'run.finished']);
    expect(trace.warnings).toEqual([]);
    const runs = await listRuns(join(root, 'traces'));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.tracePath).toBe(filePath);
  });

  it('surfaces a closed trace file as a sink error instead of dropping events', async () => {
    const root = await tempDir();
    const filePath = join(root, `${RUN}.jsonl`);
    const fileSink = new JsonlFileSink(filePath);
    await fileSink.close();
    const bus = new EventBus({ sinks: [fileSink], flushIntervalMs: 0 });

    bus.emit(input('log', { level: 'info', message: 'lost?' }));
    await bus.flush();
    expect(bus.sinkErrors).toHaveLength(1);
    await expect(bus.close()).rejects.toThrow(/closed/);
  });
});

describe('JsonlFileSink', () => {
  it('creates owner-only dirs and files and appends valid JSONL', async () => {
    const root = await tempDir();
    const filePath = join(root, 'traces', SESSION, `${RUN}.jsonl`);

    const sink = new JsonlFileSink(filePath);
    expect((await stat(join(root, 'traces', SESSION))).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    sink.write([makeEventObject('log', { level: 'info', message: 'one' })]);
    await sink.flush();
    expect((await readFile(filePath, 'utf8')).endsWith('\n')).toBe(true);

    await sink.write([makeEventObject('log', { level: 'warn', message: 'two' })]);
    await sink.close();

    const trace = await readTraceFile(filePath);
    expect(trace.events.map((event) => event.payload['message'])).toEqual(['one', 'two']);
    expect(() => sink.write([makeEventObject('log', { level: 'info', message: 'three' })])).toThrow(
      /closed/,
    );
  });

  it('tightens the mode of a pre-existing, too-open trace file', async () => {
    const root = await tempDir();
    const filePath = join(root, `${RUN}.jsonl`);
    await writeFile(filePath, 'already here\n', { mode: 0o644 });
    await chmod(filePath, 0o644);

    const sink = new JsonlFileSink(filePath);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    sink.write([makeEventObject('log', { level: 'info', message: 'appended' })]);
    await sink.close();

    const content = await readFile(filePath, 'utf8');
    expect(content.startsWith('already here\n')).toBe(true);
    expect(content).toContain('appended');
  });

  it('redacts before writing when driven through the bus', async () => {
    const root = await tempDir();
    const filePath = join(root, `${RUN}.jsonl`);
    const bus = new EventBus({
      sinks: [new JsonlFileSink(filePath)],
      flushIntervalMs: 0,
      redaction: { secretValues: ['sk-file-leak'] },
    });
    bus.emit(
      input('tool.started', toolStarted({ headers: { authorization: 'Bearer sk-file-leak' } })),
    );
    await bus.close();

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('sk-file-leak');
    const trace = await readTraceFile(filePath);
    expect(JSON.stringify(trace.events[0]?.payload)).toContain('[omitted]');
  });
});

describe('ConsoleSink', () => {
  function capture(level: 'debug' | 'info'): { lines: string[]; sink: ConsoleSink } {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    return { lines, sink: new ConsoleSink({ level, stream }) };
  }

  it('writes one compact line per event and never a secret', () => {
    const { lines, sink } = capture('info');
    const event = makeEventObject(
      'tool.started',
      toolStarted({ command: 'echo hi', api_key: 'sk-console-leak' }),
    );
    sink.write([event, makeEventObject('log', { level: 'info', message: 'hello' })]);

    expect(lines).toHaveLength(2);
    expect(lines[0]?.trimEnd()).toBe(`${event.ts} tool.started run_shell [code · exec]`);
    expect(lines[1]).toContain('log info hello');
    expect(lines.join('')).not.toContain('sk-console-leak');
  });

  it('hides debug logs at info level and redacts payloads at debug level', () => {
    const hidden = capture('info');
    hidden.sink.write([makeEventObject('log', { level: 'debug', message: 'chatter' })]);
    expect(hidden.lines).toHaveLength(0);

    const shown = capture('debug');
    shown.sink.write([
      makeEventObject('log', {
        level: 'debug',
        message: 'chatter',
        fields: { token: 'tok-123456' },
      }),
    ]);
    expect(shown.lines[0]).toContain('log debug chatter');
    expect(shown.lines[0]).toContain('"message":"chatter"');
    expect(shown.lines[0]).toContain('[redacted]');
    expect(shown.lines[0]).not.toContain('tok-123456');
  });

  it('summarises every schema v1 event type as one compact line', () => {
    const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    const error = { name: 'ProviderError', code: 'PROVIDER_NETWORK', message: 'socket closed' };
    const payloads: Record<AgentEventType, Record<string, unknown>> = {
      'run.started': runStarted('task'),
      'run.finished': { status: 'ok', durationMs: 10, usage, stepCount: 1, subagentCount: 0 },
      'run.error': { error },
      'graph.node.started': { node: 'agent', step: 2 },
      'graph.node.finished': { node: 'agent', durationMs: 30 },
      'llm.started': {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        messageCount: 3,
        toolCount: 2,
        stream: true,
      },
      'llm.completed': {
        finishReason: 'stop',
        usage,
        durationMs: 20,
        outputPreview: 'out',
        outputTruncated: false,
        outputSha256: 'aa',
      },
      'llm.error': { provider: 'openai', model: 'gpt-4.1-mini', error },
      'tool.started': toolStarted({ path: 'notes/a.md' }),
      'tool.approval.requested': {
        approvalId: 'apr_1',
        name: 'run_shell',
        source: 'code',
        risk: 'exec',
        argsPreview: { command: 'ls' },
        attempt: 1,
      },
      'tool.approval.decided': {
        approvalId: 'apr_1',
        name: 'run_shell',
        decision: 'approve',
        actor: 'user',
      },
      'tool.finished': {
        name: 'read_file',
        callId: 'call_1',
        durationMs: 4,
        resultPreview: 'text',
        truncated: false,
        sha256: 'bb',
        isError: false,
      },
      'tool.error': { name: 'run_shell', callId: 'call_9', error },
      'subagent.started': { pattern: 'supervisor', name: 'planner', depth: 0, taskPreview: 'plan' },
      'subagent.finished': {
        pattern: 'supervisor',
        name: 'planner',
        status: 'error',
        durationMs: 5,
        usage,
      },
      'subagent.handoff': { from: 'planner', to: 'worker', pattern: 'swarm' },
      'plugin.loaded': { name: 'notes', version: '1.0.0', apiVersion: '1', tools: ['read_note'] },
      'plugin.error': { name: 'notes', path: 'plugins/notes', error },
      'mcp.connected': { server: 'fs', transport: 'stdio', toolCount: 4 },
      'mcp.disconnected': { server: 'fs', reason: 'eof' },
      'mcp.error': { server: 'fs', error },
      'session.started': { sessionId: SESSION, threadId: SESSION },
      'session.resumed': { sessionId: SESSION, threadId: SESSION, checkpointId: 'chk_1' },
      'budget.exceeded': { kind: 'steps', limit: 40, used: 40 },
      'trace.redaction': { fieldsRedacted: 3 },
      log: { level: 'info', message: 'hello' },
    };

    const { lines, sink } = capture('info');
    const events = EVENT_TYPES.map((type) => makeEventObject(type, payloads[type]));
    sink.write(events);

    expect(lines).toHaveLength(EVENT_TYPES.length);
    EVENT_TYPES.forEach((type, index) => {
      const line = lines[index] ?? '';
      expect(line.startsWith(`2026-11-03T12:00:00.000Z ${type} `)).toBe(true);
      expect(line.trimEnd().length).toBeGreaterThan(`2026-11-03T12:00:00.000Z ${type} `.length);
    });
    expect(lines.join('')).toContain('socket closed');
    for (const type of ['run.error', 'llm.error', 'tool.error', 'plugin.error', 'mcp.error']) {
      expect(lines[EVENT_TYPES.indexOf(type as AgentEventType)]).toContain('socket closed');
    }
    expect(lines[EVENT_TYPES.length - 2]?.trimEnd()).toBe(
      '2026-11-03T12:00:00.000Z trace.redaction redacted fields=3',
    );
  });

  it('summarises run, llm and approval events for humans', () => {
    const { lines, sink } = capture('info');
    sink.write([
      makeEventObject('run.started', runStarted('task')),
      makeEventObject('llm.completed', {
        finishReason: 'tool_calls',
        usage: { inputTokens: 620, outputTokens: 180, totalTokens: 800 },
        durationMs: 1_200,
        outputPreview: '',
        outputTruncated: false,
        outputSha256: 'abc',
      }),
      makeEventObject('tool.approval.decided', {
        approvalId: 'apr_1',
        name: 'write_file',
        decision: 'deny',
        actor: 'user',
      }),
    ]);

    expect(lines[0]?.trimEnd()).toBe(
      '2026-11-03T12:00:00.000Z run.started openai:gpt-4.1-mini preset=single',
    );
    expect(lines[1]?.trimEnd()).toBe(
      '2026-11-03T12:00:00.000Z llm.completed tool_calls tokens=800 1200ms',
    );
    expect(lines[2]?.trimEnd()).toBe(
      '2026-11-03T12:00:00.000Z tool.approval.decided approval deny write_file actor=user',
    );
  });
});
