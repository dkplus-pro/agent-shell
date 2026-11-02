import type { BaseMessage } from '@langchain/core/messages';
import { isAIMessage } from '@langchain/core/messages';
import type { ModelScript, ProviderConfig, ResolvedConfig } from '../config/schema.js';
import { ConfigError, ProviderError } from '../errors/index.js';
import { createAnthropicHandle } from './anthropic.js';
import { createOpenaiHandle } from './openai.js';
import { capabilitiesFor, formatModelRef, parseModelRef } from './types.js';
import type {
  BaseChatModelResult,
  ChatModelHandle,
  InvokeOptions,
  ProviderRegistry,
  ResolvedProvider,
} from './types.js';
import { usageFromMetadata } from './usage.js';
import { ScriptedChatModel } from '../testing/scripted-model.js';

export type ScriptedProviderConfig = Extract<ProviderConfig, { kind: 'scripted' }>;

export interface ProviderRegistryOptions {
  /** Environment used to reveal secret references; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Turns a script reference (path or key) into an inline script. */
  scriptResolver?: (ref: string) => ModelScript;
}

function scriptKeys(providerId: string, modelId: string, agent?: string): string[] {
  // Most specific first so one provider can carry per-agent/per-model scripts.
  const keys = [`${providerId}:${modelId}`, modelId, providerId];
  return agent === undefined ? keys : [`agent:${agent}`, ...keys];
}

function resolveScript(
  providerId: string,
  modelId: string,
  config: ScriptedProviderConfig,
  scriptResolver?: (ref: string) => ModelScript,
  agent?: string,
): ModelScript | string {
  const materialize = (value: ModelScript | string): ModelScript | string =>
    typeof value === 'string' && scriptResolver !== undefined ? scriptResolver(value) : value;
  for (const key of scriptKeys(providerId, modelId, agent)) {
    const candidate = config.scripts[key];
    if (candidate !== undefined) return materialize(candidate);
  }
  if (config.script !== undefined) return materialize(config.script);
  throw new ConfigError(
    `Scripted provider "${providerId}" has no script for model "${modelId}". ` +
      `Set providers.${providerId}.script or providers.${providerId}.scripts["${providerId}:${modelId}"].`,
  );
}

function responseMetadata(message: BaseMessage, key: string): unknown {
  const metadata: unknown = message.response_metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function textOfMessage(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

/**
 * The scripted model records what it was offered and stays the same instance,
 * which is exactly what the graph tests assert (docs/04-testing-and-acceptance.md §2.1).
 */
function bindOfferedTools(model: ScriptedChatModel, tools: InvokeOptions['tools']): void {
  if (tools.length === 0) return;
  model.bindTools(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.jsonSchema,
    })),
  );
}

function scriptedHandle(
  providerId: string,
  modelId: string,
  config: ScriptedProviderConfig,
  script: ModelScript | string,
  agent: string | undefined,
): ChatModelHandle {
  const model = new ScriptedChatModel({ script, name: providerId, agent, modelId });
  const capabilities = capabilitiesFor('scripted', modelId, config.capabilities);

  const callOptions = (options: InvokeOptions): { signal?: AbortSignal } =>
    options.signal === undefined ? {} : { signal: options.signal };

  const finishReason = (message: BaseMessage): string => {
    const reported = responseMetadata(message, 'finish_reason');
    if (typeof reported === 'string' && reported.length > 0) return reported;
    return isAIMessage(message) && (message.tool_calls?.length ?? 0) > 0 ? 'tool_calls' : 'stop';
  };

  return {
    providerId,
    modelId,
    kind: 'scripted',
    capabilities,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    model,
    async invoke(messages, options): Promise<BaseChatModelResult> {
      const started = performance.now();
      bindOfferedTools(model, options.tools);
      const message = await model.invoke(messages, callOptions(options));
      const durationMs = performance.now() - started;
      // The script decides usage; `lastUsage` keeps the estimated flag honest.
      const usage =
        model.lastUsage ??
        usageFromMetadata(message.usage_metadata, {
          inputText: messages.map(textOfMessage).join(''),
          outputText: textOfMessage(message),
        });
      return {
        message,
        usage,
        finishReason: finishReason(message),
        firstTokenMs: durationMs,
        durationMs,
      };
    },
    async *stream(messages, options): AsyncIterable<string> {
      bindOfferedTools(model, options.tools);
      const iterator = await model.stream(messages, callOptions(options));
      for await (const chunk of iterator) {
        const text = textOfMessage(chunk);
        if (text.length === 0) continue;
        options.streamTokens?.(text);
        yield text;
      }
    },
  };
}

/**
 * The capability guard is what keeps FR-01 honest: a model that cannot call
 * tools must fail loudly rather than silently ignore `options.tools`.
 */
function withCapabilityGuard(handle: ChatModelHandle): ChatModelHandle {
  const guard = (options: InvokeOptions): void => {
    if (options.tools.length > 0 && !handle.capabilities.toolCalling) {
      throw new ProviderError(
        'protocol',
        `Provider "${handle.providerId}" model "${handle.modelId}" does not support tool calling, ` +
          `but ${options.tools.length} tool(s) were offered (${options.tools.map((tool) => tool.name).join(', ')}). ` +
          'Pick a tool-capable model or set capabilities.toolCalling.',
      );
    }
  };
  return {
    ...handle,
    invoke: async (messages, options) => {
      guard(options);
      return handle.invoke(messages, options);
    },
    // An async generator keeps the failure inside iteration, which is how every
    // caller consumes `stream`.
    stream: async function* (messages, options) {
      guard(options);
      yield* handle.stream(messages, options);
    },
  };
}

/**
 * Provider registry per docs/01-architecture.md §5.3. Handles are cached by the
 * formatted ref, so repeated `create()` calls reuse one model instance — the
 * scripted model's step cursor only advances when the same instance is reused.
 */
export function createProviderRegistry(
  config: ResolvedConfig,
  opts: ProviderRegistryOptions = {},
): ProviderRegistry {
  const env = opts.env ?? process.env;
  const cache = new Map<string, Promise<ChatModelHandle>>();
  let closed = false;

  const get = (providerId: string): ResolvedProvider => {
    const providerConfig = config.providers[providerId];
    if (providerConfig === undefined) {
      const available = Object.keys(config.providers);
      throw new ConfigError(
        `Unknown provider "${providerId}". Available providers: ${
          available.length > 0 ? available.join(', ') : '(none configured)'
        }.`,
      );
    }
    return {
      id: providerId,
      kind: providerConfig.kind,
      config: providerConfig,
      capabilities: capabilitiesFor(
        providerConfig.kind,
        providerConfig.models[0],
        providerConfig.capabilities,
      ),
    };
  };

  const build = async (ref: string, agent?: string): Promise<ChatModelHandle> => {
    const parsed = parseModelRef(ref);
    const provider = get(parsed.providerId);
    const providerConfig = provider.config;
    const defaultModel = providerConfig.models[0];
    const modelId = parsed.model ?? defaultModel;
    if (modelId === undefined) {
      throw new ConfigError(
        `Provider "${provider.id}" has no default model. ` +
          `Configure providers.${provider.id}.models or request an explicit reference like "${provider.id}:<model>".`,
      );
    }
    // Narrow on `config.kind`: `ResolvedProvider.kind` is a parallel field and
    // does not refine the config union.
    if (providerConfig.kind === 'openai') {
      return createOpenaiHandle(provider.id, providerConfig, modelId, env);
    }
    if (providerConfig.kind === 'anthropic') {
      return createAnthropicHandle(provider.id, providerConfig, modelId, env);
    }
    const script = resolveScript(provider.id, modelId, providerConfig, opts.scriptResolver, agent);
    return scriptedHandle(provider.id, modelId, providerConfig, script, agent);
  };

  return {
    list: () => Object.keys(config.providers).map((id) => get(id)),
    get,
    create: async (ref: string, createOpts?: { agent?: string }) => {
      if (closed)
        throw new ConfigError('Provider registry is closed; create a new registry for this run.');
      const parsed = parseModelRef(ref);
      const provider = get(parsed.providerId);
      const normalized = formatModelRef({
        providerId: provider.id,
        model: parsed.model ?? provider.config.models[0],
      });
      const agent = createOpts?.agent;
      const key = agent === undefined ? normalized : `${normalized}#${agent}`;
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      const created = build(normalized, agent).then(withCapabilityGuard);
      cache.set(key, created);
      // A failed create must not poison the cache for the rest of the run.
      created.catch(() => cache.delete(key));
      return created;
    },
    close: async () => {
      closed = true;
      cache.clear();
    },
  };
}
