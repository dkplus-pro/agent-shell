import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import { isAIMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import { ChatAnthropic, type ChatAnthropicCallOptions } from '@langchain/anthropic';
import type { ProviderConfig } from '../config/schema.js';
import type { SecretValue } from '../config/secret.js';
import { MissingSecretError, ProviderError, type ProviderErrorKind } from '../errors/index.js';
import { capabilitiesFor } from './types.js';
import type { BaseChatModelResult, ChatModelHandle, InvokeOptions } from './types.js';
import { usageFromMetadata } from './usage.js';

export type AnthropicProviderConfig = Extract<ProviderConfig, { kind: 'anthropic' }>;

type Runner = Runnable<BaseLanguageModelInput, AIMessageChunk, ChatAnthropicCallOptions>;

function toToolSpecs(tools: InvokeOptions['tools']): BindToolsInput[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.jsonSchema,
  }));
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => contentText(part)).join('');
  if (typeof content === 'object' && content !== null) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function messagesText(messages: readonly BaseMessage[]): string {
  return messages.map((message) => contentText(message.content)).join('');
}

/** The provider layer must never echo a credential, even when upstream does. */
function scrubSecret(message: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return message;
  return message.split(secret).join('[redacted]');
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

function errorText(error: unknown): string {
  const name = error instanceof Error ? `${error.name} ${error.constructor.name}` : '';
  const message = error instanceof Error ? error.message : String(error);
  return `${name} ${message}`.toLowerCase();
}

const NETWORK_TOKENS = [
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'connection',
  'network',
  'overloaded',
];

/** See the OpenAI adapter for the rationale behind signal-strength ordering. */
function classifyProviderError(error: unknown, aborted: boolean): ProviderErrorKind {
  const text = errorText(error);
  const status = statusOf(error);
  if (aborted || text.includes('abort')) return 'timeout';
  if (text.includes('timeout') || text.includes('timed out') || text.includes('etimedout'))
    return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (
    text.includes('authentication') ||
    text.includes('unauthorized') ||
    text.includes('forbidden')
  )
    return 'auth';
  if (
    text.includes('rate limit') ||
    text.includes('rate-limit') ||
    text.includes('too many requests')
  ) {
    return 'rate-limit';
  }
  if (status !== undefined && status >= 500) return 'network';
  if (NETWORK_TOKENS.some((token) => text.includes(token))) return 'network';
  if (text.includes('json') || text.includes('parse') || text.includes('typeerror'))
    return 'protocol';
  return 'protocol';
}

function secretValue(
  ref: SecretValue | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  if (ref === undefined) return undefined;
  const value = env[ref.variable];
  return value === undefined || value.length === 0 ? undefined : value;
}

function finishReasonOf(message: AIMessageChunk): string {
  const reported =
    message.response_metadata['stop_reason'] ?? message.response_metadata['finish_reason'];
  if (typeof reported === 'string' && reported.length > 0) return reported;
  return isAIMessage(message) && (message.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn';
}

/**
 * Builds an Anthropic Messages handle. Retries are passed as a call option
 * because ChatAnthropic pins the underlying SDK client to `maxRetries: 0` and
 * runs its own retry loop around the request creation.
 */
export async function createAnthropicHandle(
  providerId: string,
  config: AnthropicProviderConfig,
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ChatModelHandle> {
  const apiKey = secretValue(config.apiKey, env);
  if (apiKey === undefined) {
    throw new MissingSecretError(config.apiKey?.variable ?? 'ANTHROPIC_API_KEY');
  }
  const headers: Record<string, string> = {};
  for (const [name, ref] of Object.entries(config.headers)) {
    const value = secretValue(ref as SecretValue, env);
    if (value === undefined) throw new MissingSecretError(ref.variable);
    headers[name] = value;
  }
  const capabilities = capabilitiesFor('anthropic', modelId, config.capabilities);
  const model = new ChatAnthropic({
    apiKey,
    model: modelId,
    streaming: true,
    // `maxRetries` belongs on the constructor: ChatAnthropic also forwards a
    // call-option `maxRetries` into the SDK request options, which would retry
    // twice over ((maxRetries + 1)² requests instead of maxRetries + 1).
    maxRetries: config.maxRetries,
    ...(config.baseURL === undefined ? {} : { anthropicApiUrl: config.baseURL }),
    clientOptions: {
      timeout: config.timeoutMs,
      ...(Object.keys(headers).length === 0 ? {} : { defaultHeaders: headers }),
    },
  });

  const runner = (tools: InvokeOptions['tools']): Runner => {
    if (tools.length === 0) return model.withConfig({});
    if (typeof model.bindTools !== 'function') {
      throw new ProviderError('protocol', `Provider "${providerId}" cannot bind tools.`);
    }
    return model.bindTools(toToolSpecs(tools));
  };

  const callOptions = (options: InvokeOptions): Partial<ChatAnthropicCallOptions> =>
    options.signal === undefined ? {} : { signal: options.signal };

  const fail = (error: unknown, options: InvokeOptions): ProviderError => {
    if (error instanceof ProviderError) return error;
    const kind = classifyProviderError(error, options.signal?.aborted === true);
    const detail = error instanceof Error ? error.message : String(error);
    return new ProviderError(
      kind,
      `Anthropic provider "${providerId}" (${modelId}) failed: ${scrubSecret(detail, apiKey)}`,
      error,
    );
  };

  const handle: ChatModelHandle = {
    providerId,
    modelId,
    kind: 'anthropic',
    capabilities,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    model,
    async invoke(messages, options): Promise<BaseChatModelResult> {
      const started = performance.now();
      let message: AIMessageChunk;
      try {
        message = await runner(options.tools).invoke(messages, callOptions(options));
      } catch (error) {
        throw fail(error, options);
      }
      const durationMs = performance.now() - started;
      return {
        message,
        usage: usageFromMetadata(message.usage_metadata ?? message.response_metadata['usage'], {
          inputText: messagesText(messages),
          outputText: contentText(message.content),
        }),
        finishReason: finishReasonOf(message),
        // `invoke` resolves as a single message, so first token == completion.
        firstTokenMs: durationMs,
        durationMs,
      };
    },
    async *stream(messages, options): AsyncIterable<string> {
      let iterator: Awaited<ReturnType<Runner['stream']>>;
      try {
        iterator = await runner(options.tools).stream(messages, callOptions(options));
      } catch (error) {
        throw fail(error, options);
      }
      try {
        for await (const chunk of iterator) {
          const text = contentText(chunk.content);
          if (text.length === 0) continue;
          options.streamTokens?.(text);
          yield text;
        }
      } catch (error) {
        iterator.cancel();
        throw fail(error, options);
      }
    },
  };
  return handle;
}
