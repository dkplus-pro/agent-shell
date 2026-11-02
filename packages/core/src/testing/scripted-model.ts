import { readFileSync } from 'node:fs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  type BaseChatModelCallOptions,
  type BindToolsInput,
  SimpleChatModel,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { type z } from 'zod';
import { type ModelScript, modelScriptSchema, modelScriptStepSchema } from '../config/schema.js';
import { ConfigError, ProviderError, type ProviderErrorKind } from '../errors/index.js';
import type { TokenUsageSummary } from '../providers/types.js';
import { usageFromMetadata } from '../providers/usage.js';

type ScriptStep = z.output<typeof modelScriptStepSchema>;
type ScriptError = NonNullable<ScriptStep['error']>;
type ScriptToolCall = NonNullable<ScriptStep['toolCalls']>[number];

export interface ScriptedChatModelFields {
  /** Inline script object, inline JSON string, or a path to a JSON script file. */
  script: ModelScript | string;
  /** Display name used in the exhaustion error and traces. */
  name?: string;
  /** Agent this instance speaks for; scripts are per agent by design. */
  agent?: string;
  /** Model id reported back in `response_metadata.model_name`. */
  modelId?: string;
}

const PROVIDER_ERROR_KINDS: readonly ProviderErrorKind[] = [
  'auth',
  'rate-limit',
  'network',
  'protocol',
  'timeout',
];

function isProviderErrorKind(value: unknown): value is ProviderErrorKind {
  return typeof value === 'string' && (PROVIDER_ERROR_KINDS as readonly string[]).includes(value);
}

/**
 * A scripted error step must still surface as a provider failure, otherwise the
 * runtime loses the exit code mapping that a live provider would produce.
 */
function errorFromStep(error: ScriptError): Error {
  if (error.name === 'ProviderError') {
    const kind: ProviderErrorKind = isProviderErrorKind(error.code)
      ? error.code
      : /rate|limit|429/i.test(error.message)
        ? 'rate-limit'
        : /auth|key|token/i.test(error.message)
          ? 'auth'
          : 'protocol';
    return new ProviderError(kind, error.message);
  }
  const thrown = new Error(error.message);
  thrown.name = error.name;
  return thrown;
}

function textOf(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

function loadScript(script: ModelScript | string, source: string): ModelScript {
  if (typeof script !== 'string') return modelScriptSchema.parse(script);
  const trimmed = script.trimStart();
  // A string is either inline JSON or a path; both are untrusted test input.
  const text = trimmed.startsWith('{') ? trimmed : readFileSync(script, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`ScriptedChatModel: script "${source}" is not valid JSON.`, cause);
  }
  return modelScriptSchema.parse(parsed);
}

/**
 * Offline chat model used by every non-live test layer
 * (docs/04-testing-and-acceptance.md §2.1). It performs no network I/O and
 * consumes exactly one script step per model call, so a runaway agent fails
 * loudly instead of looping forever.
 */
export class ScriptedChatModel extends SimpleChatModel {
  readonly script: ModelScript;
  readonly displayName: string;
  readonly agent: string | undefined;
  readonly modelId: string;
  /** Tool names the runtime offered to the model, in binding order, deduped. */
  readonly boundToolNames: string[] = [];
  /** Number of script steps consumed so far. */
  calls = 0;
  /** Messages seen on the most recent call — context isolation assertions. */
  lastMessages: BaseMessage[] = [];
  /** Usage of the most recent step, `estimated` when the script omitted it. */
  lastUsage: TokenUsageSummary | undefined;

  private cursor = 0;

  constructor(fields: ScriptedChatModelFields) {
    super({});
    this.script = loadScript(fields.script, fields.name ?? 'scripted model');
    this.displayName = fields.name ?? 'ScriptedChatModel';
    this.agent = fields.agent;
    this.modelId = fields.modelId ?? 'scripted';
  }

  _llmType(): string {
    return 'scripted';
  }

  override _modelType(): string {
    return 'scripted';
  }

  /** Records what the runtime offered and stays the same instance. */
  override bindTools(tools: BindToolsInput[], _kwargs?: Partial<BaseChatModelCallOptions>): this {
    for (const tool of tools) {
      const name = (tool as { name?: unknown }).name;
      if (typeof name === 'string' && name.length > 0 && !this.boundToolNames.includes(name)) {
        this.boundToolNames.push(name);
      }
    }
    return this;
  }

  private consumeStep(
    messages: BaseMessage[],
    options?: Partial<BaseChatModelCallOptions>,
  ): ScriptStep {
    options?.signal?.throwIfAborted();
    this.lastMessages = [...messages];
    const step = this.script.steps[this.cursor];
    if (step === undefined) {
      throw new Error(
        `${this.displayName}: script exhausted after ${this.script.steps.length} steps`,
      );
    }
    this.cursor += 1;
    this.calls = this.cursor;
    if (step.error !== undefined) throw errorFromStep(step.error);
    return step;
  }

  private chunksFor(step: ScriptStep): string[] {
    // Character splitting keeps the streaming path exercised by default.
    if (step.streamChunks !== undefined) return step.streamChunks;
    return [...(step.content ?? '')];
  }

  private toolCallsFor(step: ScriptStep) {
    return (step.toolCalls ?? []).map((call: ScriptToolCall, index: number) => ({
      name: call.name,
      args: call.args,
      id: call.id ?? `${this.displayName}_call_${this.cursor}_${index}`,
      type: 'tool_call' as const,
    }));
  }

  /** Full message for a step, including tool calls and usage metadata. */
  messageFor(step: ScriptStep): AIMessage {
    const toolCalls = this.toolCallsFor(step);
    const usage = usageFromMetadata(step.usage, {
      inputText: this.lastMessages.map((message) => textOf(message.content)).join(''),
      outputText: step.content ?? '',
    });
    this.lastUsage = usage;
    return new AIMessage({
      content: step.content ?? '',
      tool_calls: toolCalls,
      usage_metadata: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
      },
      response_metadata: {
        model_name: this.modelId,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        scripted: true,
        usage_estimated: usage.estimated,
        ...(this.agent === undefined ? {} : { agent: this.agent }),
      },
    });
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const step = this.consumeStep(messages, options);
    const message = this.messageFor(step);
    // Emit the same deltas a live provider would so streaming stays covered.
    for (const text of this.chunksFor(step)) {
      options.signal?.throwIfAborted();
      await runManager?.handleLLMNewToken(text, { prompt: 0, completion: 0 });
    }
    const finishReason = message.response_metadata['finish_reason'];
    return {
      generations: [
        {
          text: typeof message.content === 'string' ? message.content : '',
          message,
          ...(typeof finishReason === 'string'
            ? { generationInfo: { finish_reason: finishReason } }
            : {}),
        },
      ],
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const step = this.consumeStep(messages, options);
    const message = this.messageFor(step);
    for (const text of this.chunksFor(step)) {
      options.signal?.throwIfAborted();
      const generation = new ChatGenerationChunk({
        message: new AIMessageChunk({ content: text }),
        text,
      });
      yield generation;
      await runManager?.handleLLMNewToken(
        text,
        { prompt: 0, completion: 0 },
        undefined,
        undefined,
        undefined,
        {
          chunk: generation,
        },
      );
    }
    for (const [index, call] of this.toolCallsFor(step).entries()) {
      const generation = new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          tool_call_chunks: [
            {
              type: 'tool_call_chunk',
              index,
              name: call.name,
              args: JSON.stringify(call.args),
              id: call.id,
            },
          ],
        }),
        text: '',
      });
      yield generation;
      await runManager?.handleLLMNewToken(
        '',
        { prompt: 0, completion: index },
        undefined,
        undefined,
        undefined,
        { chunk: generation },
      );
    }
    const usage = message.usage_metadata;
    const finishReason = message.response_metadata['finish_reason'];
    const finish = new ChatGenerationChunk({
      message: new AIMessageChunk({
        content: '',
        response_metadata: {
          ...(typeof finishReason === 'string' ? { finish_reason: finishReason } : {}),
          model_name: this.modelId,
        },
        ...(usage === undefined
          ? {}
          : {
              usage_metadata: {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
              },
            }),
      }),
      text: '',
    });
    yield finish;
  }

  /** SimpleChatModel's abstract surface; `_generate` is what the runtime calls. */
  override async _call(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<string> {
    const step = this.consumeStep(messages, options);
    const message = this.messageFor(step);
    for (const text of this.chunksFor(step)) {
      await runManager?.handleLLMNewToken(text, { prompt: 0, completion: 0 });
    }
    return typeof message.content === 'string' ? message.content : '';
  }
}

/** Convenience for tests that only need a sequence of plain text replies. */
export function scriptFromTexts(texts: readonly string[]): ModelScript {
  return modelScriptSchema.parse({ version: 1, steps: texts.map((content) => ({ content })) });
}
