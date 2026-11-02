/**
 * Scripted approval policy (`--script`, docs/03 §5). Fully deterministic and
 * TTY-free: approvals are consumed in declaration order, unmatched write/exec
 * requests are denied and mark the script as failed, and turn assertions check
 * `expect.contains` against the final answer plus `expect.exitCode` against the
 * code the run produced.
 */
import { readFileSync } from 'node:fs';
import {
  ConfigError,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
} from '@agent-shell/core';
import { z } from 'zod';

export const scriptApprovalRuleSchema = z
  .object({
    tool: z.string().min(1),
    decision: z.enum(['approve', 'deny']),
    argsMatch: z.record(z.string(), z.unknown()).optional(),
    occurrence: z.number().int().positive().optional(),
    confirmation: z.literal('run').optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ScriptApprovalRule = z.output<typeof scriptApprovalRuleSchema>;

export const scriptTurnSchema = z
  .object({
    input: z.string().min(1),
    expect: z
      .object({
        contains: z.string().optional(),
        exitCode: z.number().int().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ScriptTurn = z.output<typeof scriptTurnSchema>;

export const scriptSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1).optional(),
    preset: z.string().min(1).optional(),
    turns: z.array(scriptTurnSchema).optional(),
    approvals: z.array(scriptApprovalRuleSchema).optional(),
  })
  .strict();
export type AgentShellScript = z.output<typeof scriptSchema>;

export function loadScriptFile(path: string): AgentShellScript {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read script file ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `Script ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = scriptSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid run script ${path} — ${issues}`);
  }
  return parsed.data;
}

/** JSON-subset match: every key in `pattern` must deep-equal the same key in `value`. */
export function argsSubsetMatch(
  pattern: Record<string, unknown> | undefined,
  value: unknown,
): boolean {
  if (pattern === undefined) return true;
  return subsetMatch(pattern, value);
}

function subsetMatch(pattern: unknown, value: unknown): boolean {
  if (Array.isArray(pattern)) {
    return (
      Array.isArray(value) &&
      pattern.length === value.length &&
      pattern.every((item, index) => subsetMatch(item, value[index]))
    );
  }
  if (pattern !== null && typeof pattern === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.entries(pattern).every(
      ([key, expected]) => Object.hasOwn(record, key) && subsetMatch(expected, record[key]),
    );
  }
  return pattern === value;
}

function requestArgs(request: ApprovalRequest): Record<string, unknown> {
  const preview = request.argsPreview;
  return preview !== null && typeof preview === 'object' && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : {};
}

export interface ScriptState {
  /** Requests that had no matching rule (docs/03 §5: deny + script failure). */
  unmatched: string[];
  /** Assertion failures collected while running turns. */
  assertions: string[];
  /** Explicit matched deny rules are recorded but do not fail the script. */
  denials: string[];
  failed: boolean;
}

export class ScriptController {
  readonly unmatched: string[] = [];
  readonly assertions: string[] = [];
  readonly denials: string[] = [];
  private readonly consumed: boolean[];
  private readonly occurrences = new Map<string, number>();
  /**
   * Exec asks twice for one approval. LangGraph re-executes the tools node on
   * resume, so the second attempt arrives with a FRESH approvalId — pairing by
   * tool keeps the exec rule attached to its own second confirmation.
   */
  private readonly pendingByTool = new Map<string, number>();

  constructor(private readonly script: AgentShellScript) {
    this.consumed = new Array<boolean>(script.approvals?.length ?? 0).fill(false);
  }

  get failed(): boolean {
    return this.unmatched.length > 0 || this.assertions.length > 0;
  }

  get state(): ScriptState {
    return {
      unmatched: this.unmatched,
      assertions: this.assertions,
      denials: this.denials,
      failed: this.failed,
    };
  }

  readonly approvalHandler: ApprovalHandler = {
    decide: (request: ApprovalRequest): Promise<ApprovalDecision> =>
      Promise.resolve(this.decide(request)),
  };

  decide(request: ApprovalRequest): ApprovalDecision {
    const rules = this.script.approvals ?? [];
    let ruleIndex: number | undefined =
      request.attempt === 2 ? this.pendingByTool.get(request.tool) : undefined;

    if (ruleIndex === undefined) {
      if (request.attempt === 2) {
        // Second confirmation without a first: nothing sane to approve.
        this.unmatched.push(`${request.tool} (attempt 2 without first approval)`);
        return {
          decision: 'deny',
          actor: 'script',
          reason: 'script: exec second confirmation without first approval',
        };
      }
      const occurrence = (this.occurrences.get(request.tool) ?? 0) + 1;
      this.occurrences.set(request.tool, occurrence);
      ruleIndex = rules.findIndex(
        (rule, index) =>
          !this.consumed[index] &&
          rule.tool === request.tool &&
          (rule.occurrence === undefined || rule.occurrence === occurrence) &&
          argsSubsetMatch(rule.argsMatch, requestArgs(request)),
      );
      if (ruleIndex < 0) {
        const label = `${request.tool} (attempt ${request.attempt}, #${occurrence})`;
        this.unmatched.push(label);
        return { decision: 'deny', actor: 'script', reason: 'script: no matching approval' };
      }
      this.consumed[ruleIndex] = true;
      if (request.risk === 'exec' && rules[ruleIndex]?.decision === 'approve') {
        this.pendingByTool.set(request.tool, ruleIndex);
      } else {
        this.pendingByTool.delete(request.tool);
      }
    } else if (request.attempt === 2) {
      this.pendingByTool.delete(request.tool);
    }

    const rule = rules[ruleIndex];
    if (rule === undefined)
      return { decision: 'deny', actor: 'script', reason: 'script: rule vanished' };

    if (rule.decision === 'deny') {
      this.denials.push(`${request.tool}: ${rule.reason ?? 'denied by script'}`);
      return { decision: 'deny', actor: 'script', reason: rule.reason ?? 'denied by script' };
    }

    if (request.attempt === 2) {
      if (rule.confirmation !== 'run') {
        this.unmatched.push(`${request.tool} exec second confirmation requires "run"`);
        return {
          decision: 'deny',
          actor: 'script',
          reason: 'script: exec second confirmation requires "run"',
        };
      }
      return { decision: 'approve', actor: 'script', confirmation: 'run' };
    }
    return { decision: 'approve', actor: 'script' };
  }

  /** Asserts one turn's `expect` against the produced answer and exit code. */
  checkTurn(turn: ScriptTurn, output: string, exitCode: number): void {
    const expect = turn.expect;
    if (expect === undefined) return;
    if (expect.contains !== undefined && !output.includes(expect.contains)) {
      this.assertions.push(`turn "${turn.input}": answer does not contain "${expect.contains}"`);
    }
    if (expect.exitCode !== undefined && expect.exitCode !== exitCode) {
      this.assertions.push(
        `turn "${turn.input}": exit code ${exitCode} != expected ${expect.exitCode}`,
      );
    }
  }

  /** True when the script pins an exit code and the run matched it. */
  expectedExitCode(): number | undefined {
    const codes = (this.script.turns ?? [])
      .map((turn) => turn.expect?.exitCode)
      .filter((code): code is number => code !== undefined);
    return codes.length > 0 ? codes[codes.length - 1] : undefined;
  }
}
