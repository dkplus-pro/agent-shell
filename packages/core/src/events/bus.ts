/**
 * Event bus: the trace is a side channel, never a blocker (docs/01 §2, ADR-0006).
 * `emit` is synchronous and non-blocking; sinks are fed in async batches and a
 * failing sink is reported instead of crashing the run.
 */
import { UnexpectedError } from '../errors/index.js';
import { collectEnvSecretValues, redactEvent, type RedactionOptions } from './redaction.js';
import { makeEvent, type AgentEvent, type AgentEventType, type NewEvent } from './schema.js';
import { truncateValue } from './truncate.js';

export interface EventSink {
  readonly name: string;
  write(events: AgentEvent[]): void | Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class InMemorySink implements EventSink {
  readonly events: AgentEvent[] = [];
  private closed = false;

  constructor(readonly name: string = 'memory') {}

  write(events: AgentEvent[]): void {
    if (this.closed) throw new UnexpectedError(`Sink ${this.name} is closed`);
    this.events.push(...events);
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface EventBusOptions {
  sinks: EventSink[];
  batchSize?: number;
  /** 0 disables the periodic timer; flush()/close() still drain. */
  flushIntervalMs?: number;
  redaction?: RedactionOptions;
  maxFieldBytes?: number;
}

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_FLUSH_INTERVAL_MS = 250;
const DEFAULT_MAX_FIELD_BYTES = 16_384;
const RUN_INPUT_PREVIEW_BYTES = 2_048;
const ERROR_MESSAGE_BYTES = 4_096;
const PREVIEW_SUFFIX = 'Preview';

export class EventBus {
  private readonly sinks: EventSink[];
  private readonly batchSize: number;
  private readonly redaction: RedactionOptions;
  private readonly maxFieldBytes: number;
  private readonly queue: AgentEvent[] = [];
  private readonly failures: Error[] = [];
  private emitted = 0;
  private draining: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: EventBusOptions) {
    this.sinks = [...options.sinks];
    this.batchSize = Math.max(1, Math.trunc(options.batchSize ?? DEFAULT_BATCH_SIZE));
    this.maxFieldBytes = Math.max(0, Math.trunc(options.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES));
    // An unconfigured bus still scrubs credential-valued env vars.
    this.redaction = options.redaction ?? { secretValues: collectEnvSecretValues() };
    const interval = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    if (interval > 0) {
      this.timer = setInterval(() => this.startDrain(), interval);
      this.timer.unref();
    }
  }

  get sinkErrors(): Error[] {
    return [...this.failures];
  }

  emit(input: NewEvent<AgentEventType>): AgentEvent {
    return this.enqueue(makeEvent(input));
  }

  emitRaw(event: AgentEvent): AgentEvent {
    return this.enqueue(event);
  }

  count(): number {
    return this.emitted;
  }

  async flush(): Promise<void> {
    for (;;) {
      if (this.queue.length > 0) {
        await this.startDrain();
        continue;
      }
      if (this.draining !== null) {
        await this.draining;
        continue;
      }
      break;
    }
    for (const sink of this.sinks) {
      try {
        await sink.flush();
      } catch (error) {
        this.record(sink.name, error);
      }
    }
  }

  /**
   * Flushes and closes every sink, then rethrows the first recorded sink failure
   * so a broken trace file can never be mistaken for a clean run.
   */
  async close(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.closed = true;
    await this.flush();
    for (const sink of this.sinks) {
      try {
        await sink.close();
      } catch (error) {
        this.record(sink.name, error);
      }
    }
    const first = this.failures[0];
    if (first !== undefined) throw first;
  }

  private enqueue(event: AgentEvent): AgentEvent {
    if (this.closed) throw new UnexpectedError('EventBus is closed; the event was not recorded');
    const redacted = redactEvent(event, this.redaction);
    const prepared = truncatePayload(redacted.event, this.maxFieldBytes);
    this.emitted += 1;
    this.queue.push(prepared);
    // docs/03 §9: a redaction is reported as a count only, never as the value.
    if (redacted.fieldsRedacted > 0) {
      this.queue.push(
        makeEvent({
          type: 'trace.redaction',
          sessionId: prepared.sessionId,
          runId: prepared.runId,
          spanId: prepared.spanId,
          ...(prepared.parentSpanId === undefined ? {} : { parentSpanId: prepared.parentSpanId }),
          source: 'runtime',
          ts: prepared.ts,
          payload: { fieldsRedacted: redacted.fieldsRedacted },
        }),
      );
    }
    if (this.queue.length >= this.batchSize) this.startDrain();
    return prepared;
  }

  private startDrain(): Promise<void> {
    this.draining ??= this.drainLoop().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      await this.deliver(batch);
    }
  }

  private async deliver(batch: AgentEvent[]): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.write(batch);
      } catch (error) {
        this.record(sink.name, error);
      }
    }
  }

  private record(sinkName: string, error: unknown): void {
    this.failures.push(
      error instanceof Error ? error : new UnexpectedError(`Sink ${sinkName} failed`, error),
    );
  }
}

function previewLimit(key: string, maxFieldBytes: number): number | undefined {
  if (key === 'inputPreview') return Math.min(RUN_INPUT_PREVIEW_BYTES, maxFieldBytes);
  if (key.endsWith(PREVIEW_SUFFIX)) return maxFieldBytes;
  return undefined;
}

/**
 * Applies docs/03 §9 caps to `*Preview` fields and error messages. Flag/hash
 * siblings are only rewritten when the payload already carries them, because the
 * per-type schemas are strict and an invented key would fail validation.
 */
function truncatePayload(event: AgentEvent, maxFieldBytes: number): AgentEvent {
  const payload: Record<string, unknown> = { ...event.payload };
  let changed = false;

  for (const [key, value] of Object.entries(event.payload)) {
    const limit = previewLimit(key, maxFieldBytes);
    if (limit === undefined || typeof value === 'number' || typeof value === 'boolean') continue;
    const cut = truncateValue(value, limit);
    if (!cut.truncated) continue;
    payload[key] = cut.value;
    const stem = key.slice(0, -PREVIEW_SUFFIX.length);
    for (const flag of [`${stem}Truncated`, 'truncated']) {
      if (flag in payload) {
        payload[flag] = true;
        break;
      }
    }
    for (const hash of [`${stem}Sha256`, 'sha256']) {
      if (hash in payload) {
        payload[hash] = cut.sha256;
        break;
      }
    }
    changed = true;
  }

  const error = payload.error;
  if (isRecord(error) && typeof error.message === 'string') {
    const cut = truncateValue(error.message, Math.min(ERROR_MESSAGE_BYTES, maxFieldBytes));
    if (cut.truncated) {
      payload.error = { ...error, message: cut.value };
      changed = true;
    }
  }

  return changed ? { ...event, payload } : event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
