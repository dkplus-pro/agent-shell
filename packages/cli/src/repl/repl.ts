/**
 * readline REPL loop (docs/03 §2). Ctrl+C semantics: first press cancels the
 * running turn, second press exits; while an approval prompt is open the press
 * belongs to that prompt (deny) and is not counted here.
 */
import { createInterface } from 'node:readline/promises';
import { EXIT_CODES, exitCodeFor, type RunSummary } from '@agent-shell/core';
import { promptActivity } from '../approvals/prompt.js';
import { executeTurn } from '../commands/run.js';
import {
  configViewLines,
  mcpLines,
  parseToolSource,
  pluginLines,
  providerLines,
  sessionsLines,
  toolsLines,
  traceLinesForState,
} from '../commands/inspect.js';
import type { CliContext } from '../context.js';
import type { GlobalFlags } from '../flags.js';
import type { Renderer } from '../render/renderer.js';
import { shortId } from '../render/renderer.js';
import { dispatchReplCommand, type ReplCommandDeps, type ReplState } from './commands.js';

export interface ReplTurnRecord {
  role: 'user' | 'agent';
  text: string;
}

export interface ReplOptions {
  ctx: CliContext;
  flags: GlobalFlags;
  renderer: Renderer;
  state: ReplState;
  seedTask?: string;
}

export async function runRepl(options: ReplOptions): Promise<number> {
  const { ctx, flags, renderer, state } = options;
  const history: ReplTurnRecord[] = [];
  let exitCode = 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let done = false;
  rl.on('close', () => {
    done = true;
  });

  let busy = false;
  let cancelRequested = false;
  let activeController: AbortController | undefined;

  rl.on('SIGINT', () => {
    if (promptActivity.active) return; // the approval prompt owns this keystroke
    if (busy && !cancelRequested && activeController !== undefined) {
      cancelRequested = true;
      activeController.abort();
      renderer.progress('已取消当前 run（再按一次 Ctrl+C 退出）');
      return;
    }
    exitCode = EXIT_CODES.cancelled;
    rl.close();
  });

  const deps = buildDeps(ctx, state, history);

  if (options.seedTask !== undefined && options.seedTask.length > 0) {
    await runTurn(options.seedTask);
  }

  while (!done) {
    let line: string;
    try {
      line = await rl.question(prompt(state));
    } catch {
      break; // stdin closed (EOF) — exit cleanly
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith('/')) {
      const result = await dispatchReplCommand(trimmed, deps);
      switch (result.kind) {
        case 'output':
          renderer.lines(result.lines);
          break;
        case 'error':
          renderer.error(result.message);
          break;
        case 'exit':
          rl.close();
          break;
      }
      continue;
    }

    await runTurn(trimmed);
  }

  rl.close();
  return exitCode;

  async function runTurn(task: string): Promise<void> {
    busy = true;
    cancelRequested = false;
    activeController = new AbortController();
    history.push({ role: 'user', text: task });
    let summary: RunSummary | undefined;
    try {
      summary = await executeTurn({
        ctx,
        renderer,
        task,
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
        resume: state.resumed,
        ...(state.provider === undefined ? {} : { provider: state.provider }),
        preset: state.preset,
        signal: activeController.signal,
      });
    } catch (error) {
      const code = exitCodeFor(error);
      renderer.error(error instanceof Error ? error.message : String(error));
      if (flags.verbose) {
        renderer.error(
          error instanceof Error && error.stack !== undefined ? error.stack : String(error),
        );
      }
      history.push({
        role: 'agent',
        text: code === EXIT_CODES.cancelled ? '(cancelled)' : `(error ${code})`,
      });
      return;
    } finally {
      busy = false;
      activeController = undefined;
    }
    if (summary === undefined) return;
    state.sessionId = summary.sessionId;
    state.turnCount += 1;
    state.resumed = true;
    ctx.recordSession(summary, task);
    ctx.recordStartupEvents(summary);
    history.push({ role: 'agent', text: summary.output });
    renderer.answer(summary.output);
    renderer.summary(summary);
  }
}

function prompt(state: ReplState): string {
  const tail = state.sessionId === undefined ? '' : ` ${shortId(state.sessionId)}`;
  return `agent-shell${tail}> `;
}

function buildDeps(ctx: CliContext, state: ReplState, history: ReplTurnRecord[]): ReplCommandDeps {
  return {
    state,
    config: ctx.config,
    tools: (source) => toolsLines(ctx.registry, parseToolSource(source)),
    plugins: () => pluginLines(ctx),
    mcp: () => mcpLines(ctx),
    providers: () => providerLines(ctx),
    sessions: () => sessionsLines(ctx),
    history: (n) =>
      history.slice(-n).map((record) => `${record.role}: ${truncateOne(record.text, 200)}`),
    trace: () => traceLinesForState(ctx, state),
    configView: () => configViewLines(ctx.config),
    newSession: () => {
      state.sessionId = undefined;
      state.resumed = false;
      state.turnCount = 0;
    },
  };
}

function truncateOne(text: string, max: number): string {
  const flat = text.replace(/\n/g, ' | ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
