import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ProviderCapabilities, ProviderConfig, ProviderKind } from '../config/schema.js';
import { ConfigError } from '../errors/index.js';

export interface ModelRef {
  providerId: string;
  model?: string;
}

export function parseModelRef(ref: string): ModelRef {
  const separator = ref.indexOf(':');
  if (separator === -1) return { providerId: ref };
  const providerId = ref.slice(0, separator);
  const model = ref.slice(separator + 1);
  if (providerId.length === 0)
    throw new ConfigError(`Invalid provider reference "${ref}"; expected provider:model.`);
  return model.length > 0 ? { providerId, model } : { providerId };
}

export function formatModelRef(ref: ModelRef): string {
  return ref.model ? `${ref.providerId}:${ref.model}` : ref.providerId;
}

export interface ResolvedProvider {
  id: string;
  kind: ProviderKind;
  config: ProviderConfig;
  capabilities: ProviderCapabilities;
}

/** Everything the graph needs to call a model without knowing which SDK it is. */
export interface ChatModelHandle {
  providerId: string;
  modelId: string;
  kind: ProviderKind;
  capabilities: ProviderCapabilities;
  timeoutMs: number;
  maxRetries: number;
  readonly model: BaseChatModel;
  invoke(messages: BaseMessage[], options: InvokeOptions): Promise<BaseChatModelResult>;
  stream(messages: BaseMessage[], options: InvokeOptions): AsyncIterable<string>;
}

export interface InvokeOptions {
  tools: Array<{ name: string; description: string; jsonSchema: Record<string, unknown> }>;
  signal?: AbortSignal;
  agent?: string;
  streamTokens?: (token: string) => void;
}

export interface BaseChatModelResult {
  message: BaseMessage;
  usage: TokenUsageSummary;
  finishReason: string;
  firstTokenMs?: number;
  durationMs: number;
}

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export const DEFAULT_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  openai: { streaming: true, toolCalling: true, vision: false, contextWindow: 128_000 },
  anthropic: { streaming: true, toolCalling: true, vision: false, contextWindow: 200_000 },
  scripted: { streaming: true, toolCalling: true, vision: false, contextWindow: 32_000 },
};

export const KNOWN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4.1-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-5-mini': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
};

export function capabilitiesFor(
  kind: ProviderKind,
  modelId: string | undefined,
  override?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const base = DEFAULT_CAPABILITIES[kind];
  const contextWindow =
    override?.contextWindow ??
    (modelId ? (KNOWN_MODEL_CONTEXT_WINDOWS[modelId] ?? base.contextWindow) : base.contextWindow);
  return {
    streaming: override?.streaming ?? base.streaming,
    toolCalling: override?.toolCalling ?? base.toolCalling,
    vision: override?.vision ?? base.vision,
    contextWindow,
  };
}

export interface ProviderRegistry {
  list(): ResolvedProvider[];
  get(providerId: string): ResolvedProvider;
  /**
   * Builds a model handle. The optional agent selects a per-agent script from a
   * scripted provider, which is how multi-agent presets stay deterministic.
   */
  create(ref: string, opts?: { agent?: string }): Promise<ChatModelHandle>;
  close(): Promise<void>;
}
