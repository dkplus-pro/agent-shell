import { describe, expect, it } from 'vitest';
import { addUsage, estimateTokens, usageFromMetadata } from '../../src/providers/usage.js';

describe('estimateTokens', () => {
  it('is zero for empty text and roughly a quarter of the character count', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(41))).toBe(11);
  });
});

describe('usageFromMetadata', () => {
  it('reads snake_case LangChain usage_metadata', () => {
    const usage = usageFromMetadata({ input_tokens: 12, output_tokens: 30, total_tokens: 42 });
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 30, totalTokens: 42, estimated: false });
  });

  it('reads camelCase payloads', () => {
    const usage = usageFromMetadata({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12, estimated: false });
  });

  it('reads OpenAI prompt/completion token names', () => {
    const usage = usageFromMetadata({ prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 });
    expect(usage.inputTokens).toBe(8);
    expect(usage.outputTokens).toBe(4);
  });

  it('reads the tokenUsage carrier used in llmOutput', () => {
    const usage = usageFromMetadata({
      tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
    expect(usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7, estimated: false });
  });

  it('unwraps a nested usage object', () => {
    const usage = usageFromMetadata({
      usage_metadata: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });
    expect(usage.totalTokens).toBe(5);
  });

  it('derives a missing total from the parts', () => {
    const usage = usageFromMetadata({ input_tokens: 20, output_tokens: 5 });
    expect(usage.totalTokens).toBe(25);
    expect(usage.estimated).toBe(false);
  });

  it('estimates and flags when usage is absent', () => {
    const usage = usageFromMetadata(undefined, { inputText: 'hello world', outputText: 'hi' });
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBe(estimateTokens('hello world'));
    expect(usage.outputTokens).toBe(estimateTokens('hi'));
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
  });

  it('estimates when the provider reports all zeros', () => {
    const usage = usageFromMetadata(
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      { inputText: 'a'.repeat(40), outputText: '' },
    );
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 0, totalTokens: 10, estimated: true });
  });

  it('ignores negative and non-numeric values instead of trusting them', () => {
    const usage = usageFromMetadata(
      { input_tokens: -5, output_tokens: 'many', total_tokens: null },
      { inputText: 'some prompt', outputText: 'some answer' },
    );
    expect(usage.estimated).toBe(true);
  });

  it('produces zero-estimate with no fallback text', () => {
    expect(usageFromMetadata(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimated: true,
    });
  });
});

describe('addUsage', () => {
  it('sums every counter', () => {
    const total = addUsage(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false },
      { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false },
    );
    expect(total).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18, estimated: false });
  });

  it('stays estimated if either side was estimated', () => {
    const total = addUsage(
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
    );
    expect(total.estimated).toBe(true);
  });

  it('derives a total when the carriers reported none', () => {
    const total = addUsage(
      { inputTokens: 4, outputTokens: 4, totalTokens: 0, estimated: false },
      { inputTokens: 1, outputTokens: 1, totalTokens: 0, estimated: false },
    );
    expect(total.totalTokens).toBe(10);
  });
});
