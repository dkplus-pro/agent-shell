import type { TokenUsageSummary } from './types.js';

/**
 * English text averages ~4 characters per BPE token; the estimate only exists so
 * budgets still move when a provider omits usage (docs/01-architecture.md §5.3).
 */
const CHARS_PER_TOKEN = 4;

const INPUT_KEYS = [
  'input_tokens',
  'inputTokens',
  'prompt_tokens',
  'promptTokens',
  'input',
] as const;
const OUTPUT_KEYS = [
  'output_tokens',
  'outputTokens',
  'completion_tokens',
  'completionTokens',
  'output',
] as const;
const TOTAL_KEYS = ['total_tokens', 'totalTokens', 'total'] as const;

/** Nested carriers used by LangChain messages and provider SDK payloads. */
const NESTED_KEYS = ['usage_metadata', 'usageMetadata', 'usage', 'tokenUsage'] as const;

export interface UsageEstimationInput {
  /** Serialised prompt text, used only when the provider gave no usage. */
  inputText?: string;
  /** Generated text, used only when the provider gave no usage. */
  outputText?: string;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function firstCount(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const found = count(record[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** LangChain nests usage under `usage_metadata`; raw SDK payloads use `usage`. */
function unwrap(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 2) return undefined;
  for (const key of NESTED_KEYS) {
    const nested = unwrap(value[key], depth + 1);
    if (
      nested !== undefined &&
      firstCount(nested, [...INPUT_KEYS, ...OUTPUT_KEYS, ...TOTAL_KEYS]) !== undefined
    ) {
      return nested;
    }
  }
  return value;
}

/**
 * Normalises any LangChain/provider usage payload into a `TokenUsageSummary`.
 * Never fabricates numbers when the upstream really reported usage; only the
 * absent/all-zero case falls back to the character estimate with `estimated`.
 */
export function usageFromMetadata(
  usage: unknown,
  fallback?: UsageEstimationInput,
): TokenUsageSummary {
  const record = unwrap(usage, 0);
  if (record !== undefined) {
    const inputTokens = firstCount(record, INPUT_KEYS) ?? 0;
    const outputTokens = firstCount(record, OUTPUT_KEYS) ?? 0;
    const reportedTotal = firstCount(record, TOTAL_KEYS);
    const totalTokens = reportedTotal ?? inputTokens + outputTokens;
    if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
      return {
        inputTokens,
        outputTokens,
        totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
        estimated: false,
      };
    }
  }
  const inputTokens = estimateTokens(fallback?.inputText ?? '');
  const outputTokens = estimateTokens(fallback?.outputText ?? '');
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}

export function addUsage(a: TokenUsageSummary, b: TokenUsageSummary): TokenUsageSummary {
  const inputTokens = a.inputTokens + b.inputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  const totalTokens = a.totalTokens + b.totalTokens;
  return {
    inputTokens,
    outputTokens,
    // A summed budget is only as trustworthy as its least trustworthy part.
    estimated: a.estimated || b.estimated,
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
  };
}
