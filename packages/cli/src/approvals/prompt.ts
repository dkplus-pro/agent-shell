/**
 * Interactive approval prompts (docs/03 §3). The block always shows tool name,
 * source, risk and the verbatim args/target — never a model-written summary.
 * Exec asks twice; the second step requires typing `run`. Ctrl+C denies.
 */
import {
  approvalPrompt,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  truncateText,
} from '@agent-shell/core';
import { confirm, input } from '@inquirer/prompts';
import type { Renderer } from '../render/renderer.js';

/** Values under these keys are shown complete even when long (docs/03 §3 rules). */
const NEVER_TRUNCATE = new Set(['path', 'command', 'cmd', 'url', 'file']);
/** Above this size a displayed value is cut and annotated (full args still reach the tool). */
const VALUE_INLINE_LIMIT = 400;

export function formatApprovalBlock(request: ApprovalRequest): string[] {
  const args =
    request.argsPreview !== null &&
    typeof request.argsPreview === 'object' &&
    !Array.isArray(request.argsPreview)
      ? (request.argsPreview as Record<string, unknown>)
      : {};

  if (request.risk === 'exec') {
    // exec shows 命令 instead of the generic 目标 line (docs/03 §3.2).
    const command = request.target ?? firstString(args, ['command', 'cmd']) ?? JSON.stringify(args);
    return [
      approvalPrompt(request).split('\n')[0] ?? `⚠ exec · ${request.source} · ${request.tool}`,
      `命令: ${command}`,
      `来源: ${request.source} · 风险: ${request.risk}`,
    ];
  }

  const lines = approvalPrompt(request).split('\n');

  if (lines.length === 1) {
    lines.push(
      `目标: ${request.target ?? firstString(args, ['path', 'file', 'url']) ?? '(unknown)'}`,
    );
  }
  lines.push('参数:');
  for (const [key, value] of Object.entries(args)) {
    lines.push(`  ${key}: ${renderValue(key, value)}`);
  }
  return lines;
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function renderValue(key: string, value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  if (NEVER_TRUNCATE.has(key) || Buffer.byteLength(text, 'utf8') <= VALUE_INLINE_LIMIT) {
    return text.length > 4000 ? `${text.slice(0, 3997)}…` : text;
  }
  const cut = truncateText(text, VALUE_INLINE_LIMIT);
  const size =
    Buffer.byteLength(text, 'utf8') < 1024
      ? `${Buffer.byteLength(text, 'utf8')} B`
      : `${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(1)} KB`;
  return `${JSON.stringify(cut.text)}… (${size}，审批展示可截断；完整参数传给工具)`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortPromptError' ||
      error.name === 'ExitPromptError' ||
      /abort/i.test(error.message))
  );
}

/**
 * The REPL's Ctrl+C handler consults this so an approval prompt's own SIGINT
 * (docs/03 §2: deny, do not cancel the run) is not double-counted as a cancel.
 */
export const promptActivity = { active: false };

export function createPromptApprovalHandler(renderer: Renderer): ApprovalHandler {
  return {
    async decide(request: ApprovalRequest): Promise<ApprovalDecision> {
      renderer.promptBlock(formatApprovalBlock(request));
      promptActivity.active = true;
      try {
        if (request.attempt === 2) {
          const typed = await input({ message: '第二次确认：输入 run 以执行，输入其他内容取消：' });
          if (typed.trim() === 'run') {
            return { decision: 'approve', actor: 'user', confirmation: 'run' };
          }
          return {
            decision: 'deny',
            actor: 'user',
            reason: "second confirmation did not match 'run'",
          };
        }
        const message =
          request.attempt === 1 && request.risk === 'exec'
            ? '第一次确认：批准执行？'
            : '批准执行？';
        const approved = await confirm({ message, default: false });
        if (!approved) return { decision: 'deny', actor: 'user', reason: 'user denied' };
        return { decision: 'approve', actor: 'user' };
      } catch (error) {
        if (isAbortError(error)) {
          // Ctrl+C on an approval prompt denies that tool, never kills the run.
          return { decision: 'deny', actor: 'user', reason: 'cancelled at prompt' };
        }
        throw error;
      } finally {
        promptActivity.active = false;
      }
    },
  };
}
