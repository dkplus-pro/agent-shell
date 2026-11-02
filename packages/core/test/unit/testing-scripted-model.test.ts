import { HumanMessage, isAIMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { modelScriptSchema } from '../../src/config/schema.js';
import { ProviderError } from '../../src/errors/index.js';
import { ScriptedChatModel, scriptFromTexts } from '../../src/testing/scripted-model.js';

const TOOL_SCRIPT = modelScriptSchema.parse({
  version: 1,
  steps: [
    { content: 'hello' },
    {
      toolCalls: [
        { name: 'read_file', args: { path: 'notes/a.md' } },
        { name: 'search_notes', args: { query: 'hi' }, id: 'call_2' },
      ],
    },
  ],
});

const ERROR_SCRIPT = modelScriptSchema.parse({
  version: 1,
  steps: [{ error: { name: 'ProviderError', message: 'rate limited', code: 'rate-limit' } }],
});

function messages(count: number): HumanMessage[] {
  return Array.from({ length: count }, (_unused, index) => new HumanMessage(`turn ${index}`));
}

describe('ScriptedChatModel', () => {
  it('returns scripted content one step at a time', async () => {
    const model = new ScriptedChatModel({ script: TOOL_SCRIPT, modelId: 'fake-model' });
    const first = await model.invoke(messages(1));
    expect(first.content).toBe('hello');
    expect(model.calls).toBe(1);
    expect(model.lastMessages).toHaveLength(1);
    expect(first.response_metadata['model_name']).toBe('fake-model');
  });

  it('records the last messages so context isolation is assertable', async () => {
    const model = new ScriptedChatModel({ script: TOOL_SCRIPT });
    await model.invoke([new HumanMessage('only me')]);
    expect(model.lastMessages.map((message) => message.content)).toEqual(['only me']);
  });

  it('maps toolCalls to AIMessage.tool_calls with the registered names', async () => {
    const model = new ScriptedChatModel({ script: TOOL_SCRIPT });
    model.bindTools([{ name: 'read_file', description: 'reads', schema: { type: 'object' } }]);
    model.bindTools([
      { name: 'search_notes', description: 'searches', schema: { type: 'object' } },
    ]);
    await model.invoke(messages(1));
    const second = await model.invoke(messages(2));
    expect(isAIMessage(second)).toBe(true);
    if (!isAIMessage(second)) throw new Error('unreachable');
    const toolCalls = second.tool_calls ?? [];
    expect(toolCalls.map((call) => call.name)).toEqual(['read_file', 'search_notes']);
    expect(toolCalls[0]?.args).toEqual({ path: 'notes/a.md' });
    expect(toolCalls[1]?.id).toBe('call_2');
    expect(typeof toolCalls[0]?.id).toBe('string');
    expect(second.response_metadata['finish_reason']).toBe('tool_calls');
  });

  it('bindTools returns the same instance and records offered names', () => {
    const model = new ScriptedChatModel({ script: TOOL_SCRIPT });
    const bound = model.bindTools([
      { name: 'read_file', description: 'reads', schema: { type: 'object' } },
      { name: 'search_notes', description: 'searches', schema: { type: 'object' } },
    ]);
    expect(bound).toBe(model);
    expect(model.boundToolNames).toEqual(['read_file', 'search_notes']);
  });

  it('throws on exhaustion instead of looping', async () => {
    const model = new ScriptedChatModel({ script: TOOL_SCRIPT });
    await model.invoke(messages(1));
    await model.invoke(messages(2));
    expect(model.calls).toBe(2);
    await expect(model.invoke(messages(3))).rejects.toThrow(/script exhausted after 2 steps/);
    expect(model.calls).toBe(2);
  });

  it('raises the scripted error step as a ProviderError', async () => {
    const model = new ScriptedChatModel({ script: ERROR_SCRIPT });
    const failure = await model.invoke(messages(1)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({
      name: 'ProviderError',
      message: 'rate limited',
      code: 'PROVIDER_RATE_LIMIT',
    });
    expect(model.calls).toBe(1);
  });

  it('streams per-character chunks that concatenate to the content', async () => {
    const model = new ScriptedChatModel({ script: scriptFromTexts(['héllo']) });
    const stream = await model.stream(messages(1));
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk.content === 'string' ? chunk.content : '');
    }
    expect(chunks.filter((chunk) => chunk.length > 0)).toEqual(['h', 'é', 'l', 'l', 'o']);
    expect(chunks.join('')).toBe('héllo');
  });

  it('honours explicit streamChunks and merges tool call deltas', async () => {
    const model = new ScriptedChatModel({
      script: modelScriptSchema.parse({
        version: 1,
        steps: [
          { streamChunks: ['ab', 'cd'], content: 'abcd' },
          { toolCalls: [{ name: 'read_file', args: { path: 'x' }, id: 'call_1' }] },
        ],
      }),
    });
    const streamed = await model.invoke(messages(1));
    expect(streamed.content).toBe('abcd');

    const toolTurn = await model.invoke(messages(2));
    if (!isAIMessage(toolTurn)) throw new Error('expected an AIMessage');
    expect(toolTurn.tool_calls).toEqual([
      { name: 'read_file', args: { path: 'x' }, id: 'call_1', type: 'tool_call' },
    ]);
  });

  it('reports script usage verbatim and estimates when omitted', async () => {
    const reported = new ScriptedChatModel({
      script: modelScriptSchema.parse({
        version: 1,
        steps: [{ content: 'ok', usage: { inputTokens: 11, outputTokens: 7 } }],
      }),
    });
    const first = await reported.invoke(messages(1));
    expect(first.usage_metadata).toMatchObject({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
    });
    expect(reported.lastUsage?.estimated).toBe(false);

    const estimated = new ScriptedChatModel({ script: scriptFromTexts(['four tokens?']) });
    await estimated.invoke(messages(1));
    expect(estimated.lastUsage?.estimated).toBe(true);
  });

  it('respects an aborted signal', async () => {
    const model = new ScriptedChatModel({ script: scriptFromTexts(['never']) });
    const controller = new AbortController();
    controller.abort();
    await expect(model.invoke(messages(1), { signal: controller.signal })).rejects.toThrow();
    expect(model.calls).toBe(0);
  });

  it('loads a JSON string script and rejects an invalid one', async () => {
    const inline = new ScriptedChatModel({
      script: JSON.stringify({ version: 1, steps: [{ content: 'inline' }] }),
    });
    await expect(inline.invoke(messages(1))).resolves.toMatchObject({ content: 'inline' });
    expect(
      () => new ScriptedChatModel({ script: JSON.stringify({ version: 2, steps: [] }) }),
    ).toThrow();
  });
});
