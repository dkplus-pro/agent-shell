/**
 * Trace reader: turns a run's JSONL back into spans, a summary and the tree the
 * CLI renders (docs/03 §7, §8). A crash can leave a half-written last line, so
 * reading is tolerant — bad lines are skipped and reported, never thrown.
 */
import { open, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { ConfigError, UnexpectedError } from '../errors/index.js';
import type { RunListEntry, SpanNode } from '../runtime/types.js';
import { TOOL_SOURCES } from '../tools/types.js';
import {
  parseEventLine,
  RUN_STATUSES,
  TOKEN_USAGE_SCHEMA,
  TOOL_RISKS,
  validateEvent,
  type AgentEvent,
  type AgentEventType,
  type RunStatus,
  type TokenUsage,
} from './schema.js';

export interface ReadTrace {
  events: AgentEvent[];
  warnings: string[];
}

const READ_CHUNK_BYTES = 64 * 1024;
const TAIL_POLL_MS = 100;

export async function readTraceFile(path: string): Promise<ReadTrace> {
  return parseTraceText(await readFile(path, 'utf8'));
}

function parseTraceText(text: string): ReadTrace {
  const events: AgentEvent[] = [];
  const warnings: string[] = [];
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    try {
      events.push(validateEvent(JSON.parse(line) as unknown));
    } catch (error) {
      const trailing = index === lines.length - 1 ? ' (trailing partial line)' : '';
      warnings.push(`line ${index + 1}${trailing}: ${errorMessage(error)}`);
    }
  }
  return { events, warnings };
}

const KIND_BY_TYPE: Partial<Record<AgentEventType, SpanNode['kind']>> = {
  'run.started': 'run',
  'run.finished': 'run',
  'run.error': 'run',
  'graph.node.started': 'node',
  'graph.node.finished': 'node',
  'llm.started': 'llm',
  'llm.completed': 'llm',
  'llm.error': 'llm',
  'tool.started': 'tool',
  'tool.finished': 'tool',
  'tool.error': 'tool',
  'tool.approval.requested': 'approval',
  'tool.approval.decided': 'approval',
  'subagent.started': 'subagent',
  'subagent.finished': 'subagent',
  'subagent.handoff': 'subagent',
};

export function buildSpanTree(events: AgentEvent[]): SpanNode[] {
  const grouped = new Map<string, AgentEvent[]>();
  const parents = new Map<string, string>();
  for (const event of events) {
    const bucket = grouped.get(event.spanId);
    if (bucket === undefined) grouped.set(event.spanId, [event]);
    else bucket.push(event);
    if (event.parentSpanId !== undefined && !parents.has(event.spanId)) {
      parents.set(event.spanId, event.parentSpanId);
    }
  }

  const nodes = new Map<string, SpanNode>();
  for (const [spanId, spanEvents] of grouped) {
    const sorted = [...spanEvents].sort(byEventOrder);
    const parentSpanId = parents.get(spanId);
    const timings = timingsOf(sorted);
    nodes.set(spanId, {
      spanId,
      ...(parentSpanId === undefined || parentSpanId === spanId ? {} : { parentSpanId }),
      kind: kindOf(sorted),
      label: labelOf(sorted),
      startedAt: sorted[0]?.ts ?? '',
      ...timings,
      events: sorted,
      children: [],
      meta: metaOf(sorted),
    });
  }

  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentSpanId === undefined ? undefined : nodes.get(node.parentSpanId);
    if (parent === undefined || createsCycle(parent, node, nodes)) {
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  sortSiblings(roots);
  for (const node of nodes.values()) sortSiblings(node.children);
  return roots;
}

/**
 * A malformed trace can point a parent back into its own descendant; dropping
 * that one link keeps the run renderable instead of recursing forever.
 */
function createsCycle(parent: SpanNode, node: SpanNode, nodes: Map<string, SpanNode>): boolean {
  const seen = new Set<string>([node.spanId]);
  let cursor: SpanNode | undefined = parent;
  while (cursor !== undefined) {
    if (seen.has(cursor.spanId)) return true;
    seen.add(cursor.spanId);
    cursor = cursor.parentSpanId === undefined ? undefined : nodes.get(cursor.parentSpanId);
  }
  return false;
}

function sortSiblings(siblings: SpanNode[]): void {
  siblings.sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId),
  );
}

function kindOf(events: AgentEvent[]): SpanNode['kind'] {
  // A span is whatever opened it, so the first event with a known kind wins.
  for (const event of events) {
    const kind = KIND_BY_TYPE[event.type];
    if (kind !== undefined) return kind;
  }
  return 'node';
}

function labelOf(events: AgentEvent[]): string {
  for (const event of events) {
    const payload = event.payload;
    const model = text(payload['model']);
    const label =
      event.type === 'run.started'
        ? `${text(payload['provider']) ?? 'unknown'}:${model ?? 'unknown'}`
        : (text(payload['name']) ??
          text(payload['node']) ??
          model ??
          text(payload['finishReason']));
    if (label !== undefined) return label;
  }
  return events[0]?.type ?? 'span';
}

function timingsOf(events: AgentEvent[]): { endedAt?: string; durationMs?: number } {
  const last = events.at(-1);
  const explicit = events
    .map((event) => number(event.payload['durationMs']))
    .filter((value): value is number => value !== undefined)
    .at(-1);
  const observed = spanMs(events);
  return {
    ...(last === undefined ? {} : { endedAt: last.ts }),
    durationMs: explicit ?? observed,
  };
}

function metaOf(events: AgentEvent[]): SpanNode['meta'] {
  const meta: SpanNode['meta'] = {};
  for (const event of events) {
    const payload = event.payload;
    const risk = enumValue(TOOL_RISKS, payload['risk']);
    if (risk !== undefined) meta.risk = risk;
    const source = enumValue(TOOL_SOURCES, payload['source']);
    if (source !== undefined) meta.source = source;
    const status = enumValue(RUN_STATUSES, payload['status']);
    if (status !== undefined) meta.status = status;
    const usage = usageOf(payload['usage']);
    if (usage !== undefined) meta.usage = usage;
    const decision = payload['decision'];
    if (decision === 'approve' || decision === 'deny') meta.approvalDecision = decision;
    if (payload['truncated'] === true || payload['outputTruncated'] === true) meta.truncated = true;
    const depth = number(payload['depth']);
    if (depth !== undefined) meta.depth = depth;
    const pattern = payload['pattern'];
    if (pattern === 'spawn' || pattern === 'supervisor' || pattern === 'swarm')
      meta.pattern = pattern;
    if (event.type === 'tool.error' || event.type === 'llm.error' || payload['isError'] === true) {
      meta.isError = true;
    }
  }
  return meta;
}

export function summarizeRun(events: AgentEvent[]): RunListEntry {
  const sorted = [...events].sort(byEventOrder);
  const first = sorted[0];
  if (first === undefined) throw new UnexpectedError('Cannot summarize a trace with no events');

  let startedAt = first.ts;
  let status: RunStatus = 'error';
  let provider = 'unknown';
  let model = 'unknown';
  let durationMs: number | undefined;
  let totalTokens = 0;
  let observedTokens = 0;
  let steps = 0;
  let approvals = 0;
  let subagents = 0;
  let finished = false;

  for (const event of sorted) {
    const payload = event.payload;
    switch (event.type) {
      case 'run.started':
        startedAt = event.ts;
        provider = text(payload['provider']) ?? provider;
        model = text(payload['model']) ?? model;
        break;
      case 'run.finished': {
        finished = true;
        status = enumValue(RUN_STATUSES, payload['status']) ?? 'error';
        durationMs = number(payload['durationMs']);
        totalTokens = usageOf(payload['usage'])?.totalTokens ?? 0;
        steps = number(payload['stepCount']) ?? steps;
        subagents = number(payload['subagentCount']) ?? subagents;
        break;
      }
      case 'graph.node.started':
        steps += 1;
        break;
      case 'subagent.started':
        subagents += 1;
        break;
      case 'tool.approval.decided':
        approvals += 1;
        break;
      case 'llm.completed':
      case 'subagent.finished':
        observedTokens += usageOf(payload['usage'])?.totalTokens ?? 0;
        break;
      default:
        break;
    }
  }

  return {
    runId: first.runId,
    sessionId: first.sessionId,
    startedAt,
    status,
    provider,
    model,
    durationMs: finished ? (durationMs ?? 0) : (spanMs(sorted) ?? 0),
    totalTokens: finished ? totalTokens : observedTokens,
    stepCount: steps,
    approvalCount: approvals,
    subagentCount: subagents,
    tracePath: '',
  };
}

export function renderSpanTree(nodes: SpanNode[], opts: { verbose?: boolean } = {}): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) =>
    renderNode(node, '', index === nodes.length - 1, lines, opts.verbose === true, true),
  );
  return lines;
}

function renderNode(
  node: SpanNode,
  prefix: string,
  isLast: boolean,
  lines: string[],
  verbose: boolean,
  isRoot: boolean,
): void {
  const slot = isRoot ? '' : `${prefix}${connector(isLast)}`;
  const childPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
  const logs = node.events.filter((event) => event.type === 'log');
  const logOnly = logs.length === node.events.length;

  if (logOnly) {
    // Hidden unless --verbose: a log-only span is diagnostic, not structure.
    if (verbose) {
      logs.forEach((log, index) => {
        lines.push(
          `${index === 0 ? slot : `${childPrefix}${connector(index === logs.length - 1)}`}log  ${logText(log)}`,
        );
      });
    }
  } else {
    lines.push(`${slot}${describe(node)}`);
  }

  const logChildren = verbose && !logOnly ? logs : [];
  const total = node.children.length + logChildren.length;
  let position = 0;
  for (const log of logChildren) {
    lines.push(`${childPrefix}${connector(position === total - 1)}log  ${logText(log)}`);
    position += 1;
  }
  for (const child of node.children) {
    renderNode(child, childPrefix, position === total - 1, lines, verbose, false);
    position += 1;
  }
}

function connector(isLast: boolean): string {
  return isLast ? '└─ ' : '├─ ';
}

function describe(node: SpanNode): string {
  const duration = tail(formatMs(node.durationMs));
  const usage = node.meta.usage;
  switch (node.kind) {
    case 'run': {
      const runId = node.events[0]?.runId ?? node.spanId;
      const tokens = usage === undefined ? '' : `  tokens=${formatCount(usage.totalTokens)}`;
      return `${shortId(runId)}  ${node.meta.status ?? 'unknown'}${duration}  ${node.label}${tokens}`;
    }
    case 'node':
      return `node ${node.label}${duration}`;
    case 'llm': {
      const split =
        usage === undefined
          ? ''
          : `  ${formatCount(usage.inputTokens)}/${formatCount(usage.outputTokens)}`;
      return `llm ${node.label}${duration}${split}`;
    }
    case 'tool': {
      const flags = [
        node.meta.risk,
        node.meta.source,
        node.meta.approvalDecision === undefined
          ? undefined
          : `approval=${node.meta.approvalDecision}`,
      ]
        .filter((flag): flag is string => flag !== undefined)
        .join(' · ');
      const result = node.meta.isError === true ? 'error' : 'ok';
      return `tool ${node.label}${flags.length > 0 ? `  [${flags}]` : ''}${duration}  ${result}${node.meta.truncated === true ? ' (truncated)' : ''}`;
    }
    case 'approval':
      return `approval ${node.label}  ${node.meta.approvalDecision ?? 'pending'}`;
    case 'subagent': {
      const pattern = node.meta.pattern === undefined ? '' : ` ${node.meta.pattern}`;
      const depth = node.meta.depth === undefined ? '' : `  depth=${node.meta.depth}`;
      const status = node.meta.status === undefined ? '' : `  ${node.meta.status}`;
      return `subagent${pattern} ${node.label}${depth}${duration}${status}`;
    }
    default:
      return node.label;
  }
}

function logText(event: AgentEvent): string {
  const level = text(event.payload['level']) ?? 'debug';
  return `${level}  ${text(event.payload['message']) ?? ''}`;
}

function tail(value: string): string {
  return value.length === 0 ? '' : `  ${value}`;
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function shortId(id: string): string {
  const separator = id.indexOf('_');
  if (separator < 0) return id;
  const head = id.slice(0, separator + 1);
  const rest = id.slice(separator + 1);
  return rest.length <= 4 ? id : `${head}${rest.slice(0, 4)}...`;
}

export async function listRuns(traceRoot: string, sessionId?: string): Promise<RunListEntry[]> {
  const root = resolve(traceRoot);
  const dirs: string[] = [];
  if (sessionId !== undefined) {
    // The session id arrives from a CLI flag: refuse anything that could escape
    // the trace root instead of reading an arbitrary path (AGENT.md §4).
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new ConfigError(`Invalid session id "${sessionId}" for trace listing`);
    }
    dirs.push(sessionId);
  } else {
    // A missing trace dir legitimately means "no runs yet"; per-entry failures are skipped.
    try {
      const entries = await readdir(root, { withFileTypes: true });
      dirs.push(
        ...entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('ses_'))
          .map((entry) => entry.name),
      );
    } catch {
      return [];
    }
  }

  const runs: RunListEntry[] = [];
  for (const dir of dirs) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = (await readdir(dirPath)).filter(
        (name) => name.startsWith('run_') && name.endsWith('.jsonl'),
      );
    } catch {
      continue;
    }
    for (const file of files) {
      const tracePath = join(dirPath, file);
      let trace: ReadTrace;
      try {
        trace = await readTraceFile(tracePath);
      } catch {
        continue;
      }
      if (trace.events.length === 0) continue;
      runs.push({ ...summarizeRun(trace.events), tracePath });
    }
  }

  return runs.sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId),
  );
}

/**
 * Replays existing lines then follows appends until `signal` aborts, so a live
 * run can be watched from its start (docs/03 §8.2).
 */
export async function tailTrace(
  path: string,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const handle = await open(path, 'r');
  const decoder = new TextDecoder('utf8');
  const buffer = new Uint8Array(READ_CHUNK_BYTES);
  let offset = 0;
  let residual = '';
  try {
    while (!signal.aborted) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        await sleep(TAIL_POLL_MS, signal);
        continue;
      }
      offset += bytesRead;
      const lines =
        `${residual}${decoder.decode(buffer.subarray(0, bytesRead), { stream: true })}`.split('\n');
      residual = lines.pop() ?? '';
      for (const line of lines) {
        // A partial tail line is expected mid-write, so unparseable lines are dropped here.
        const event = parseEventLine(line);
        if (event !== undefined) onEvent(event);
      }
    }
  } finally {
    await handle.close();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    timer.unref();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function spanMs(events: AgentEvent[]): number | undefined {
  const start = events[0];
  const end = events.at(-1);
  if (start === undefined || end === undefined) return undefined;
  return diffMs(start.ts, end.ts);
}

function diffMs(from: string, to: string): number | undefined {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function usageOf(value: unknown): TokenUsage | undefined {
  const parsed = TOKEN_USAGE_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function enumValue<T extends readonly string[]>(
  candidates: T,
  value: unknown,
): T[number] | undefined {
  return candidates.includes(value as T[number]) ? (value as T[number]) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function byEventOrder(a: AgentEvent, b: AgentEvent): number {
  return a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
