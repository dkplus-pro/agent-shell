import { z } from 'zod';

export const allowlistRuleSchema = z
  .object({
    tool: z.string().min(1),
    argsMatch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type AllowlistRule = z.infer<typeof allowlistRuleSchema>;

/**
 * Subset match on purpose: an allowlist entry describes the arguments that must
 * be present, everything else is ignored so `run_shell` can be scoped to a path
 * prefix without listing the rest of the payload.
 */
export function argsSubsetMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return deepEqual(expected, actual);
  if (typeof actual !== 'object' || actual === null) return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => argsSubsetMatch(item, actual[index]));
  }
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    argsSubsetMatch(value, (actual as Record<string, unknown>)[key]),
  );
}

export function matchesAllowlist(
  rules: AllowlistRule[],
  tool: string,
  args: Record<string, unknown>,
): boolean {
  return rules.some(
    (rule) =>
      rule.tool === tool && (rule.argsMatch === undefined || argsSubsetMatch(rule.argsMatch, args)),
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
