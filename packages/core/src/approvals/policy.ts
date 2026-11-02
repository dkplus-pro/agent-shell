import type { Risk } from '../events/schema.js';
import type { ToolSourceKind } from '../tools/types.js';
import { matchesAllowlist, type AllowlistRule } from './allowlist.js';

export type { AllowlistRule };
export { matchesAllowlist } from './allowlist.js';

export type ApprovalActor = 'user' | 'policy' | 'script';

export type ApprovalRisk = Exclude<Risk, 'read'>;

export interface ApprovalRequest {
  approvalId: string;
  tool: string;
  source: ToolSourceKind;
  risk: ApprovalRisk;
  argsPreview: unknown;
  attempt: 1 | 2;
  /** Path or command shown verbatim; never a model-written summary. */
  target?: string;
  description?: string;
  runId: string;
  spanId: string;
}

export type ApprovalDecision =
  | { decision: 'approve'; actor: ApprovalActor; confirmation?: 'run'; reason?: string }
  | { decision: 'deny'; actor: ApprovalActor; reason: string };

export interface ApprovalHandler {
  decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export type ApprovalOutcome =
  | { kind: 'auto-approve'; reason: 'read' | 'allowlist' | 'yolo' }
  | { kind: 'require-approval'; attempts: 1 | 2 }
  | { kind: 'deny'; reason: string; actor: ApprovalActor };

export interface ApprovalPolicyContext {
  risk: Risk;
  tool: string;
  source: ToolSourceKind;
  args: Record<string, unknown>;
  target?: string;
  interactive: boolean;
  yolo: boolean;
  allowlist: AllowlistRule[];
  extraHardDeny: string[];
  timeoutMs: number;
}

/**
 * Order matters: the hard-deny net is evaluated before `--yolo` so a destructive
 * command can never be waved through (docs/01-architecture.md §5.5).
 */
export function evaluateApproval(ctx: ApprovalPolicyContext): ApprovalOutcome {
  if (ctx.risk === 'exec') {
    const blocked = findHardDeny(ctx.target ?? JSON.stringify(ctx.args), ctx.extraHardDeny);
    if (blocked) return { kind: 'deny', reason: `hard-deny: ${blocked}`, actor: 'policy' };
  }
  if (ctx.risk === 'read') return { kind: 'auto-approve', reason: 'read' };
  if (matchesAllowlist(ctx.allowlist, ctx.tool, ctx.args))
    return { kind: 'auto-approve', reason: 'allowlist' };
  if (ctx.yolo) return { kind: 'auto-approve', reason: 'yolo' };
  if (!ctx.interactive) {
    return { kind: 'deny', reason: 'non-interactive', actor: 'policy' };
  }
  return { kind: 'require-approval', attempts: ctx.risk === 'exec' ? 2 : 1 };
}

/** Prompt text is rendered by the CLI; core only supplies the stable shape. */
export function approvalPrompt(request: ApprovalRequest): string {
  const target = request.target ? `\n目标: ${request.target}` : '';
  return `⚠ ${request.risk} · ${request.source} · ${request.tool}${target}`;
}

export const HARD_DENY_PATTERNS: readonly string[] = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf .',
  'mkfs',
  'dd if=',
  'dd of=/dev/',
  '> /dev/sd',
  ':(){ :|:& };:',
  'chmod -R 777 /',
  'chown -R root /',
  'git push --force',
];

/** Single tokens are matched on word boundaries so "sudoer" cannot trip "sudo". */
export const HARD_DENY_WORDS: readonly string[] = [
  'sudo',
  'doas',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
];

export function findHardDeny(command: string, extra: string[] = []): string | undefined {
  const normalized = command.replace(/\s+/g, ' ').trim().toLowerCase();
  const words = normalized.split(/[^a-z0-9_./:-]+/);
  const substringHits = [...HARD_DENY_PATTERNS, ...extra.map((pattern) => pattern.toLowerCase())];
  const substring = substringHits.find((pattern) =>
    normalized.includes(pattern.trim().toLowerCase()),
  );
  if (substring) return substring;
  const word = [...HARD_DENY_WORDS, ...extra.map((pattern) => pattern.toLowerCase())].find(
    (pattern) => words.includes(pattern),
  );
  return word;
}
