/**
 * Trace commands' view layer (docs/03 §8). All reading/tree logic lives in
 * core (`readTraceFile`, `buildSpanTree`, `renderSpanTree`, `listRuns`,
 * `tailTrace`); this module only shapes output and routes it through the
 * renderer so stdout/stderr rules stay enforceable.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSpanTree,
  listRuns,
  readTraceFile,
  renderSpanTree,
  tailTrace,
  type RunListEntry,
} from '@agent-shell/core';
import { formatMs, formatTable, shortId, type Renderer } from './render/renderer.js';

export interface TraceViewOptions {
  traceDir: string;
  renderer: Renderer;
}

export async function showTraceList(view: TraceViewOptions, sessionId?: string): Promise<void> {
  const runs = await listRuns(view.traceDir, sessionId);
  if (view.renderer.mode === 'json') {
    for (const run of runs) view.renderer.lines([JSON.stringify(entryFields(run))]);
    return;
  }
  if (runs.length === 0) {
    view.renderer.lines(['(no runs recorded)']);
    return;
  }
  const header = [
    'RUN ID',
    'SESSION',
    'STARTED',
    'STATUS',
    'PROVIDER:MODEL',
    'DURATION',
    'TOKENS',
    'STEPS',
    'APPROVALS',
    'SUBAGENTS',
  ];
  const rows = runs.map((run) => [
    shortId(run.runId),
    shortId(run.sessionId),
    formatStarted(run.startedAt),
    run.status,
    run.model.length > 0 ? `${run.provider}:${run.model}` : run.provider,
    formatMs(run.durationMs),
    run.totalTokens.toLocaleString('en-US'),
    String(run.stepCount),
    String(run.approvalCount),
    String(run.subagentCount),
  ]);
  view.renderer.lines(formatTable(header, rows));
}

function entryFields(run: RunListEntry): Record<string, unknown> {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    status: run.status,
    provider: run.provider,
    model: run.model,
    durationMs: run.durationMs,
    totalTokens: run.totalTokens,
    stepCount: run.stepCount,
    approvalCount: run.approvalCount,
    subagentCount: run.subagentCount,
    tracePath: run.tracePath,
  };
}

function formatStarted(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

/** Locates `run_<id>.jsonl` under the trace dir; accepts exact or prefix ids. */
export function findTraceFile(traceDir: string, runIdArg: string): string {
  const wanted = runIdArg.endsWith('.jsonl') ? path.basename(runIdArg, '.jsonl') : runIdArg;
  if (!fs.existsSync(traceDir)) {
    throw new Error(`No trace directory at ${traceDir}. Run something first, or pass --trace-dir.`);
  }
  const matches: string[] = [];
  for (const session of fs.readdirSync(traceDir)) {
    const dir = path.join(traceDir, session);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const stem = file.slice(0, -'.jsonl'.length);
      if (stem === wanted || stem.startsWith(wanted)) matches.push(path.join(dir, file));
    }
  }
  if (matches.length === 0)
    throw new Error(`No trace found for run "${runIdArg}" under ${traceDir}.`);
  if (matches.length > 1) {
    throw new Error(
      `Run id "${runIdArg}" is ambiguous (${matches.length} matches); use a longer id.`,
    );
  }
  return matches[0] ?? '';
}

export async function showTraceRun(
  view: TraceViewOptions,
  runIdArg: string,
  opts: { raw?: boolean },
): Promise<void> {
  const file = findTraceFile(view.traceDir, runIdArg);
  if (opts.raw === true) {
    view.renderer.lines(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0),
    );
    return;
  }
  const trace = await readTraceFile(file);
  for (const warning of trace.warnings) view.renderer.progress(`trace warning: ${warning}`);
  if (view.renderer.mode === 'json') {
    for (const event of trace.events) view.renderer.lines([JSON.stringify(event)]);
    return;
  }
  const tree = renderSpanTree(buildSpanTree(trace.events), { verbose: view.renderer.verbose });
  view.renderer.lines(tree);
}

export async function followTraceRun(
  view: TraceViewOptions,
  runIdArg: string,
  signal: AbortSignal,
): Promise<void> {
  const file = findTraceFile(view.traceDir, runIdArg);
  await tailTrace(
    file,
    (event) => {
      if (view.renderer.mode === 'json') {
        view.renderer.lines([JSON.stringify(event)]);
        return;
      }
      view.renderer.event(event);
    },
    signal,
  );
}
