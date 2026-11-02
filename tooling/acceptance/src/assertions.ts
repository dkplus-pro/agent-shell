import fs from 'node:fs';
import path from 'node:path';
import {
  listRuns,
  readTraceFile,
  validateEvent,
  buildSpanTree,
  type AgentEvent,
} from '@agent-shell/core';

export interface TraceFacts {
  file: string;
  events: AgentEvent[];
  types: Set<string>;
}

export class Failures {
  readonly items: string[] = [];
  add(message: string): void {
    this.items.push(message);
    console.error(`  ✗ ${message}`);
  }
  get count(): number {
    return this.items.length;
  }
}

export function ok(message: string): void {
  console.log(`  ✓ ${message}`);
}

export async function loadTraces(traceRoot: string): Promise<TraceFacts[]> {
  const facts: TraceFacts[] = [];
  if (!fs.existsSync(traceRoot)) return facts;
  for (const session of fs.readdirSync(traceRoot)) {
    const dir = path.join(traceRoot, session);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      const { events, warnings } = await readTraceFile(full);
      if (warnings.length > 0)
        throw new Error(`trace ${file} reported warnings: ${warnings.join(', ')}`);
      facts.push({ file: full, events, types: new Set(events.map((event) => event.type)) });
    }
  }
  return facts.sort((a, b) => a.file.localeCompare(b.file));
}

export function flatten(traces: TraceFacts[]): AgentEvent[] {
  return traces.flatMap((trace) => trace.events);
}

/** Event schema v1 must accept every written line (docs/04 §4.3 architecture). */
export function assertSchemaValid(traces: TraceFacts[], failures: Failures): void {
  let checked = 0;
  for (const trace of traces) {
    for (const line of fs.readFileSync(trace.file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        validateEvent(JSON.parse(line));
        checked += 1;
      } catch (error) {
        failures.add(
          `schema violation in ${path.basename(trace.file)}: ${(error as Error).message}`,
        );
      }
    }
  }
  if (checked > 0) ok(`${checked} trace lines validate against event schema v1`);
  else failures.add('no trace lines were validated');
}

export function assertRunPairs(traces: TraceFacts[], failures: Failures): void {
  for (const trace of traces) {
    const started = trace.events.filter((event) => event.type === 'run.started').length;
    const finished = trace.events.filter((event) => event.type === 'run.finished').length;
    if (started !== 1 || finished !== 1) {
      failures.add(
        `${path.basename(trace.file)}: run.started=${started} run.finished=${finished}, expected 1/1`,
      );
      continue;
    }
    const status = (
      trace.events.find((event) => event.type === 'run.finished')?.payload as { status?: string }
    )?.status;
    if (status !== 'ok' && status !== 'cancelled' && status !== 'denied') {
      failures.add(`${path.basename(trace.file)}: unexpected run status ${String(status)}`);
    }
  }
  if (failures.items.length === 0)
    ok(`${traces.length} runs each emitted exactly one run.started/run.finished pair`);
}

/** Startup notices are run-level facts, not members of the run's span tree. */
const STANDALONE_TYPES = new Set([
  'plugin.loaded',
  'plugin.error',
  'mcp.connected',
  'mcp.disconnected',
  'mcp.error',
  'session.started',
  'session.resumed',
  'log',
]);

export function assertSpanLinks(events: AgentEvent[], failures: Failures): void {
  const roots = new Set(
    events
      .filter((event) => event.type === 'run.started' || event.type === 'session.started')
      .map((event) => event.spanId),
  );
  let nested = 0;
  for (const event of events) {
    if (STANDALONE_TYPES.has(event.type)) continue;
    if (event.spanId === event.parentSpanId) {
      failures.add(`event ${event.type} is its own parent`);
    }
    if (event.parentSpanId) nested += 1;
    else if (!roots.has(event.spanId)) {
      failures.add(`event ${event.type} has no parentSpanId and is not a root span`);
    }
  }
  if (nested > 0) ok(`${nested}/${events.length} events carry parentSpanId links`);
}

export function assertApprovalCounts(
  events: AgentEvent[],
  expectations: { write: number; exec: number },
  failures: Failures,
): void {
  const requested = events.filter((event) => event.type === 'tool.approval.requested');
  const decided = events.filter((event) => event.type === 'tool.approval.decided');
  const writeRequests = requested.filter(
    (event) => (event.payload as { risk?: string }).risk === 'write',
  );
  const execRequests = requested.filter(
    (event) => (event.payload as { risk?: string }).risk === 'exec',
  );
  if (writeRequests.length !== expectations.write) {
    failures.add(
      `expected ${expectations.write} write approval request(s), got ${writeRequests.length}`,
    );
  }
  if (execRequests.length !== expectations.exec) {
    failures.add(
      `expected ${expectations.exec} exec approval request(s), got ${execRequests.length}`,
    );
  }
  const attempts = execRequests
    .map((event) => (event.payload as { attempt?: number }).attempt)
    .sort();
  if (!attempts.includes(1) || !attempts.includes(2)) {
    failures.add(`exec approvals must show attempt 1 and 2, saw ${JSON.stringify(attempts)}`);
  }
  const requestedIds = requested
    .map((event) => (event.payload as { approvalId?: string }).approvalId)
    .sort();
  const decidedIds = decided
    .map((event) => (event.payload as { approvalId?: string }).approvalId)
    .sort();
  if (requestedIds.length !== decidedIds.length) {
    failures.add(`requested ${requestedIds.length} approvals but ${decidedIds.length} decisions`);
  }
  for (const id of requestedIds) {
    if (!decidedIds.includes(id)) failures.add(`approval ${id} has no matching decision`);
  }
  if (requestedIds.length > 0 && failures.count === 0)
    ok(`${requestedIds.length} approvals requested and decided 1:1`);
}

export function assertToolSources(events: AgentEvent[], failures: Failures): void {
  const sources = new Set(
    events
      .filter((event) => event.type === 'tool.started')
      .map((event) => (event.payload as { source?: string }).source),
  );
  for (const expected of ['code', 'plugin', 'mcp']) {
    if (!sources.has(expected)) failures.add(`no tool.started event with source "${expected}"`);
  }
  if (sources.size >= 3) ok(`tool.started covers sources ${[...sources].sort().join(', ')}`);
}

export function assertNamespaces(events: AgentEvent[], names: string[], failures: Failures): void {
  const toolNames = new Set(
    events
      .filter((event) => event.type === 'tool.started')
      .map((event) => (event.payload as { name?: string }).name),
  );
  for (const name of names) {
    if (!toolNames.has(name))
      failures.add(`tool ${name} was never executed (saw ${[...toolNames].join(', ') || 'none'})`);
  }
  if (names.length > 0 && failures.count === 0)
    ok(`namespaced tool names present: ${names.join(', ')}`);
}

export function assertSubagents(
  events: AgentEvent[],
  patterns: string[],
  failures: Failures,
): void {
  const started = events.filter((event) => event.type === 'subagent.started');
  const seen = new Set(started.map((event) => (event.payload as { pattern?: string }).pattern));
  for (const pattern of patterns) {
    if (!seen.has(pattern)) failures.add(`no subagent.started with pattern "${pattern}"`);
  }
  const depths = started.map((event) => (event.payload as { depth?: number }).depth ?? 0);
  if (depths.some((depth) => depth > 2))
    failures.add(`subagent depth exceeded 2: ${JSON.stringify(depths)}`);
  const handoffs = events.filter((event) => event.type === 'subagent.handoff').length;
  if (handoffs < 2) failures.add(`expected at least 2 subagent.handoff events, got ${handoffs}`);
  if (seen.size >= patterns.length && handoffs >= 2)
    ok(`subagents observed for ${[...seen].join(', ')} with ${handoffs} handoffs`);
}

export function assertTree(events: AgentEvent[], failures: Failures): void {
  const nodes = buildSpanTree(events);
  if (nodes.length === 0) {
    failures.add('buildSpanTree produced no root nodes');
    return;
  }
  const total = nodes.reduce((sum, node) => sum + 1 + node.children.length, 0);
  if (total > 1) ok(`span tree built: ${nodes.length} root(s), ${total} node(s)`);
  else failures.add('span tree has no children — trace lacks nested spans');
}

export async function assertListRuns(traceRoot: string, failures: Failures): Promise<void> {
  const runs = await listRuns(traceRoot);
  if (runs.length === 0) failures.add('trace list found no runs');
  else ok(`trace list found ${runs.length} run(s)`);
}

export function assertNoSecret(files: string[], secret: string, failures: Failures): void {
  const leaks: string[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(secret)) leaks.push(file);
  }
  if (leaks.length > 0) failures.add(`secret leaked into ${leaks.join(', ')}`);
  else ok(`fake secret absent from ${files.length} artifact(s)`);
}

export function assertContains(
  haystack: string,
  needle: string,
  label: string,
  failures: Failures,
): void {
  if (!haystack.includes(needle)) failures.add(`${label}: expected output to contain "${needle}"`);
  else ok(`${label} contains "${needle}"`);
}

export function writeIfMissing(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, content, { mode: 0o600 });
}
