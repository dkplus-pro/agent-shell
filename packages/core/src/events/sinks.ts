/**
 * Event sinks. The JSONL file is the source of truth (ADR-0006) and is written
 * owner-only; the console sink is a projection and therefore redacts again so a
 * secret cannot reach a terminal even if the caller skipped the bus policy.
 */
import { chmodSync, closeSync, mkdirSync, openSync, write } from 'node:fs';
import { dirname } from 'node:path';
import { UnexpectedError } from '../errors/index.js';
import type { EventSink } from './bus.js';
import { redactEvent } from './redaction.js';
import type { AgentEvent } from './schema.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class JsonlFileSink implements EventSink {
  readonly name = 'jsonl';
  private readonly buffer: string[] = [];
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private fd: number | null;

  constructor(readonly filePath: string) {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // recursive mkdir only modes the leaf and honours umask, so pin both modes
    // (docs/03 §7: trace dir 0700, trace file 0600).
    chmodSync(dir, DIR_MODE);
    this.fd = openSync(filePath, 'a', FILE_MODE);
    chmodSync(filePath, FILE_MODE);
  }

  write(events: AgentEvent[]): void {
    if (this.fd === null) throw new UnexpectedError(`Trace file ${this.filePath} is closed`);
    for (const event of events) this.buffer.push(`${JSON.stringify(event)}\n`);
    // The chain must never reject: a failed append is recorded and rethrown by
    // flush()/close(), so a broken trace file cannot crash a running agent and
    // cannot leave an unhandled rejection behind.
    this.pending = this.pending
      .then(() => this.appendReady())
      .catch((error: unknown) => {
        this.failure ??=
          error instanceof Error ? error : new UnexpectedError('Trace append failed', error);
      });
  }

  async flush(): Promise<void> {
    for (;;) {
      const pending = this.pending;
      await pending;
      if (this.pending === pending && this.buffer.length === 0) break;
    }
    if (this.failure !== null) throw this.failure;
  }

  async close(): Promise<void> {
    let failure: unknown;
    try {
      await this.flush();
    } catch (error) {
      failure = error;
    }
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    if (failure !== undefined) throw failure;
  }

  private async appendReady(): Promise<void> {
    const fd = this.fd;
    if (fd === null || this.buffer.length === 0) return;
    const payload = Buffer.from(this.buffer.splice(0, this.buffer.length).join(''), 'utf8');
    // `fsp.appendFile` refuses a numeric fd, so the write goes against the
    // descriptor the constructor opened with O_APPEND and mode 0600.
    await new Promise<void>((resolveAppend, rejectAppend) => {
      write(fd, payload, 0, payload.length, null, (error) =>
        error === null ? resolveAppend() : rejectAppend(error),
      );
    });
  }
}

export class ConsoleSink implements EventSink {
  readonly name = 'console';
  private readonly level: 'debug' | 'info';
  private readonly stream: NodeJS.WritableStream;

  constructor(opts?: { level?: 'debug' | 'info'; stream?: NodeJS.WritableStream }) {
    this.level = opts?.level ?? 'info';
    this.stream = opts?.stream ?? process.stderr;
  }

  write(events: AgentEvent[]): void {
    for (const original of events) {
      // A projection of a trace can be pasted into a screenshot: redact again.
      const { event } = redactEvent(original);
      if (this.level === 'info' && isDebugLog(event)) continue;
      const detail = this.level === 'debug' ? `  ${JSON.stringify(event.payload)}` : '';
      this.stream.write(`${event.ts} ${event.type} ${summary(event)}${detail}\n`);
    }
  }

  async flush(): Promise<void> {
    /* writes are unbuffered */
  }

  async close(): Promise<void> {
    /* the stream is owned by the caller */
  }
}

function isDebugLog(event: AgentEvent): boolean {
  return event.type === 'log' && event.payload.level === 'debug';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function field(value: unknown, key: string): string {
  if (!isRecord(value)) return '?';
  const raw = value[key];
  return text(raw) ?? num(raw)?.toString() ?? '?';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summary(event: AgentEvent): string {
  const p = event.payload;
  const name = text(p['name']) ?? '';
  const duration = (key = 'durationMs') => {
    const ms = num(p[key]);
    return ms === undefined ? '' : `${ms}ms`;
  };
  switch (event.type) {
    case 'run.started':
      return `${text(p['provider']) ?? '?'}:${text(p['model']) ?? '?'} preset=${text(p['preset']) ?? '?'}`;
    case 'run.finished':
      return `${text(p['status']) ?? '?'} ${duration()} steps=${num(p['stepCount']) ?? 0}`;
    case 'run.error':
      return `error=${field(p['error'], 'message')}`;
    case 'graph.node.started':
      return `node=${name || text(p['node']) || '?'} step=${num(p['step']) ?? 0}`;
    case 'graph.node.finished':
      return `node=${text(p['node']) ?? '?'} ${duration()}`;
    case 'llm.started':
      return `${text(p['provider']) ?? '?'}:${text(p['model']) ?? '?'} msgs=${num(p['messageCount']) ?? 0}`;
    case 'llm.completed':
      return `${text(p['finishReason']) ?? '?'} tokens=${field(p['usage'], 'totalTokens')} ${duration()}`;
    case 'llm.error':
      return `${text(p['provider']) ?? '?'}:${text(p['model']) ?? '?'} error=${field(p['error'], 'message')}`;
    case 'tool.started':
      return `${name} [${text(p['source']) ?? '?'} · ${text(p['risk']) ?? '?'}]`;
    case 'tool.approval.requested':
      return `approval requested ${name} [${text(p['risk']) ?? '?'}] attempt=${num(p['attempt']) ?? 1}`;
    case 'tool.approval.decided':
      return `approval ${text(p['decision']) ?? '?'} ${name} actor=${text(p['actor']) ?? '?'}`;
    case 'tool.finished':
      return `${name} ${p['isError'] === true ? 'error' : 'ok'} ${duration()}`;
    case 'tool.error':
      return `${name} error=${field(p['error'], 'message')}`;
    case 'subagent.started':
      return `subagent ${text(p['pattern']) ?? '?'} ${name} depth=${num(p['depth']) ?? 0}`;
    case 'subagent.finished':
      return `subagent ${name} ${text(p['status']) ?? '?'} ${duration()}`;
    case 'subagent.handoff':
      return `handoff ${text(p['from']) ?? '?'} -> ${text(p['to']) ?? '?'}`;
    case 'plugin.loaded': {
      const tools = Array.isArray(p['tools']) ? p['tools'].length : 0;
      return `plugin ${name}@${text(p['version']) ?? '?'} tools=${tools}`;
    }
    case 'plugin.error':
      return `plugin ${name} at ${text(p['path']) ?? '?'} error=${field(p['error'], 'message')}`;
    case 'mcp.connected':
      return `mcp ${text(p['server']) ?? '?'} ${text(p['transport']) ?? '?'}`;
    case 'mcp.disconnected':
      return `mcp ${text(p['server']) ?? '?'} disconnected`;
    case 'mcp.error':
      return `mcp ${text(p['server']) ?? '?'} error=${field(p['error'], 'message')}`;
    case 'budget.exceeded':
      return `budget ${text(p['kind']) ?? '?'} used=${num(p['used']) ?? 0} limit=${num(p['limit']) ?? 0}`;
    case 'trace.redaction':
      return `redacted fields=${num(p['fieldsRedacted']) ?? 0}`;
    case 'log':
      return `${text(p['level']) ?? 'info'} ${text(p['message']) ?? ''}`.trim();
    case 'session.started':
      return `session ${text(p['sessionId']) ?? '?'}`;
    case 'session.resumed':
      return `session ${text(p['sessionId']) ?? '?'} resumed`;
    default:
      return name || event.source;
  }
}
