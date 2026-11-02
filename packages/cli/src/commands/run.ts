/**
 * `run <task>` — one-shot execution, human/JSON/quiet output and the scripted
 * (`--script`) offline mode (docs/03 §1, §4, §5). All execution lives in core's
 * RunManager; this module only parses, renders and answers approvals.
 */
import { ConfigError, EXIT_CODES, type RunSummary, exitCodeFor } from '@agent-shell/core';
import { promptActivity } from '../approvals/prompt.js';
import { onCancel } from '../cancel.js';
import { createPromptApprovalHandler } from '../approvals/prompt.js';
import { ScriptController, loadScriptFile } from '../approvals/script.js';
import { createContext, type CliContext } from '../context.js';
import type { GlobalFlags } from '../flags.js';
import type { Renderer } from '../render/renderer.js';

export interface TurnOptions {
  ctx: CliContext;
  renderer: Renderer;
  task: string;
  sessionId?: string;
  resume?: boolean;
  provider?: string;
  preset?: string;
  signal: AbortSignal;
}

export async function executeTurn(options: TurnOptions): Promise<RunSummary> {
  const { ctx, renderer, task } = options;
  return await ctx.runManager.startRun({
    task,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    resume: options.resume === true,
    signal: options.signal,
    onToken: (token: string) => renderer.token(token),
    onEvent: (event) => renderer.event(event),
  });
}

export function hasInteractiveTerminal(flags: GlobalFlags): boolean {
  return (
    process.stdin.isTTY === true && process.stdout.isTTY === true && !flags.json && !flags.quiet
  );
}

export async function runCommand(
  flags: GlobalFlags,
  task: string,
  renderer: Renderer,
): Promise<number> {
  if (flags.script !== undefined) return await runScripted(flags, task, renderer);

  const interactive = hasInteractiveTerminal(flags);
  const approvalHandler = interactive ? createPromptApprovalHandler(renderer) : undefined;
  const ctx = await createContext({ flags, interactive, approvalHandler });
  const controller = new AbortController();
  const detach = attachSigint(controller);
  try {
    const summary = await executeTurn({
      ctx,
      renderer,
      task,
      ...(flags.session === undefined ? {} : { sessionId: flags.session }),
      ...(flags.provider === undefined ? {} : { provider: flags.provider }),
      ...(flags.preset === undefined ? {} : { preset: flags.preset }),
      signal: controller.signal,
    });
    renderer.answer(summary.output);
    renderer.summary(summary);
    ctx.recordSession(summary, task);
    ctx.recordStartupEvents(summary);
    return 0;
  } catch (error) {
    renderer.error(describe(error));
    if (flags.verbose) renderer.error(stackOf(error));
    return exitCodeFor(error);
  } finally {
    detach();
    await ctx.close();
  }
}

async function runScripted(flags: GlobalFlags, task: string, renderer: Renderer): Promise<number> {
  const script = loadScriptFile(flags.script ?? '');
  const provider = flags.provider ?? script.provider;
  const preset = flags.preset ?? script.preset;
  const controller = new ScriptController(script);
  // Scripted mode routes approvals to the script, so core must treat the run as
  // approvable; the "user" is the script and there is no TTY (docs/03 §5).
  const ctx = await createContext({
    flags,
    interactive: true,
    approvalHandler: controller.approvalHandler,
  });
  const abort = new AbortController();
  const detach = attachSigint(abort);

  const turns = script.turns ?? [];
  const effectiveTurns = turns.length > 0 ? turns : [{ input: task }];
  if (effectiveTurns.length === 0 || (effectiveTurns[0]?.input ?? '').length === 0) {
    throw new ConfigError('Nothing to run: pass a task or define script turns[].');
  }

  let sessionId = flags.session;
  let code = 0;
  try {
    for (const turn of effectiveTurns) {
      try {
        const summary = await executeTurn({
          ctx,
          renderer,
          task: turn.input,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(provider === undefined ? {} : { provider }),
          ...(preset === undefined ? {} : { preset }),
          signal: abort.signal,
        });
        sessionId = summary.sessionId;
        renderer.answer(summary.output);
        renderer.summary(summary);
        ctx.recordSession(summary, turn.input);
        ctx.recordStartupEvents(summary);
        controller.checkTurn(turn, summary.output, 0);
      } catch (error) {
        code = exitCodeFor(error);
        renderer.error(describe(error));
        controller.checkTurn(turn, '', code);
        break;
      }
    }

    for (const message of controller.unmatched) {
      renderer.error(`script failure — unmatched approval request: ${message}`);
    }
    for (const message of controller.assertions) {
      renderer.error(`script failure — ${message}`);
    }
    if (controller.failed && code === 0) code = EXIT_CODES.approvalDenied;

    const expected = controller.expectedExitCode();
    if (expected !== undefined && expected !== code) {
      renderer.error(`script expected exit code ${expected}, actual ${code}`);
    }
    return code;
  } finally {
    detach();
    await ctx.close();
  }
}

export function attachSigint(controller: AbortController): () => void {
  return onCancel(() => {
    // Ctrl+C while an approval prompt is open belongs to the prompt (deny that
    // tool, keep the run) — docs/03 §2.
    if (promptActivity.active) return;
    controller.abort();
  });
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stackOf(error: unknown): string {
  return error instanceof Error && error.stack !== undefined ? error.stack : String(error);
}
