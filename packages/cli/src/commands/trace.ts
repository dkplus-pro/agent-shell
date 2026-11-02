/**
 * `trace list|show|tail` — thin command wrappers around the trace view module
 * (docs/03 §8). No run logic here.
 */
import path from 'node:path';
import { discoverConfigPath, loadConfig, resolveRuntimePaths } from '@agent-shell/core';
import type { GlobalFlags } from '../flags.js';
import type { Renderer } from '../render/renderer.js';
import {
  followTraceRun,
  showTraceList,
  showTraceRun,
  type TraceViewOptions,
} from '../trace-view.js';

/** Trace commands read the filesystem only: config resolves paths, nothing else runs. */
export async function traceView(flags: GlobalFlags, renderer: Renderer): Promise<TraceViewOptions> {
  const configPath = discoverConfigPath({ explicit: flags.config });
  if (configPath === undefined) {
    // Fall back to the documented default location relative to the workspace.
    const base = flags.traceDir ?? path.join(flags.workspace ?? process.cwd(), '.agent-shell');
    return { traceDir: path.join(base, 'traces'), renderer };
  }
  const loaded = await loadConfig(configPath);
  const paths = resolveRuntimePaths(loaded.config, loaded.baseDir, {
    workspaceFlag: flags.workspace,
    traceDirFlag: flags.traceDir,
  });
  return { traceDir: paths.traceDir, renderer };
}

export async function traceListCommand(flags: GlobalFlags, renderer: Renderer): Promise<number> {
  const view = await traceView(flags, renderer);
  await showTraceList(view, flags.session);
  return 0;
}

export async function traceShowCommand(
  flags: GlobalFlags,
  renderer: Renderer,
  runId: string,
  opts: { raw: boolean },
): Promise<number> {
  const view = await traceView(flags, renderer);
  await showTraceRun(view, runId, { raw: opts.raw });
  return 0;
}

export async function traceTailCommand(
  flags: GlobalFlags,
  renderer: Renderer,
  runId: string,
): Promise<number> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const view = await traceView(flags, renderer);
    await followTraceRun(view, runId, controller.signal);
    return 0;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
