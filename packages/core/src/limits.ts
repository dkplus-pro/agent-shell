import { z } from 'zod';

/** Budget defaults are a contract, not a suggestion (docs/01-architecture.md §5.1). */
export const DEFAULT_LIMITS = {
  maxSteps: 40,
  tokenBudget: 200_000,
  maxWallTimeMs: 900_000,
  maxSubagents: 8,
  maxSubagentDepth: 2,
} as const;

export const limitsSchema = z
  .object({
    maxSteps: z.number().int().positive().default(DEFAULT_LIMITS.maxSteps),
    tokenBudget: z.number().int().positive().default(DEFAULT_LIMITS.tokenBudget),
    maxWallTimeMs: z.number().int().positive().default(DEFAULT_LIMITS.maxWallTimeMs),
    maxSubagents: z.number().int().nonnegative().default(DEFAULT_LIMITS.maxSubagents),
    maxSubagentDepth: z.number().int().nonnegative().default(DEFAULT_LIMITS.maxSubagentDepth),
  })
  .strict();

export type Limits = z.infer<typeof limitsSchema>;

export const partialLimitsSchema = limitsSchema.partial();

export function mergeLimits(...layers: Array<Partial<Limits> | undefined>): Limits {
  const merged: Record<string, unknown> = { ...DEFAULT_LIMITS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged as Limits;
}

export type BudgetKind = 'steps' | 'tokens' | 'time' | 'subagents' | 'depth';

export interface BudgetUsage {
  steps: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** True while every observed usage came from estimation rather than the provider. */
  estimated: boolean;
  elapsedMs: number;
  subagents: number;
  depth: number;
}

export function emptyUsage(): BudgetUsage {
  return {
    steps: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimated: true,
    elapsedMs: 0,
    subagents: 0,
    depth: 0,
  };
}

export interface BudgetCheck {
  exceeded: boolean;
  kind?: BudgetKind;
  limit?: number;
  used?: number;
}

export function checkBudget(usage: BudgetUsage, limits: Limits): BudgetCheck {
  if (usage.steps >= limits.maxSteps)
    return { exceeded: true, kind: 'steps', limit: limits.maxSteps, used: usage.steps };
  if (usage.tokens >= limits.tokenBudget)
    return { exceeded: true, kind: 'tokens', limit: limits.tokenBudget, used: usage.tokens };
  if (usage.elapsedMs >= limits.maxWallTimeMs)
    return { exceeded: true, kind: 'time', limit: limits.maxWallTimeMs, used: usage.elapsedMs };
  if (usage.subagents >= limits.maxSubagents)
    return { exceeded: true, kind: 'subagents', limit: limits.maxSubagents, used: usage.subagents };
  if (usage.depth > limits.maxSubagentDepth)
    return { exceeded: true, kind: 'depth', limit: limits.maxSubagentDepth, used: usage.depth };
  return { exceeded: false };
}
