/**
 * `chat` and `sessions resume <id>` — the REPL entry points. The chat command
 * is the program's default command (docs/03 §1).
 */
import { createPromptApprovalHandler } from '../approvals/prompt.js';
import { hasInteractiveTerminal } from './run.js';
import { createContext } from '../context.js';
import type { GlobalFlags } from '../flags.js';
import type { Renderer } from '../render/renderer.js';
import { newSessionState } from './inspect.js';
import { runRepl } from '../repl/repl.js';

export async function chatCommand(
  flags: GlobalFlags,
  seedTask: string,
  renderer: Renderer,
): Promise<number> {
  const interactive = hasInteractiveTerminal(flags);
  const approvalHandler = interactive ? createPromptApprovalHandler(renderer) : undefined;
  const ctx = await createContext({ flags, interactive, approvalHandler });
  const state = newSessionState(flags, flags.session, false);
  try {
    return await runRepl({
      ctx,
      flags,
      renderer,
      state,
      ...(seedTask.length > 0 ? { seedTask } : {}),
    });
  } finally {
    await ctx.close();
  }
}

export async function resumeSessionCommand(
  flags: GlobalFlags,
  sessionId: string,
  renderer: Renderer,
): Promise<number> {
  const interactive = hasInteractiveTerminal(flags);
  const approvalHandler = interactive ? createPromptApprovalHandler(renderer) : undefined;
  const ctx = await createContext({ flags, interactive, approvalHandler });
  const state = newSessionState(flags, sessionId, true);
  try {
    return await runRepl({ ctx, flags, renderer, state });
  } finally {
    await ctx.close();
  }
}
