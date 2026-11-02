import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { ChatResult } from '@langchain/core/outputs';
import type { ProviderCapabilities } from '../../../src/config/schema.js';
import type { ChatModelHandle } from '../../../src/providers/types.js';
import { DEFAULT_CAPABILITIES } from '../../../src/providers/types.js';

export type FakeReply = string | { toolCalls: ToolCall[] };

export interface FakeChatModelFields {
  replies: FakeReply[];
  /** Agent the produced AI messages are attributed to (swarm/supervisor routing). */
  agentName?: string;
}

/**
 * Minimal scripted chat model: the providers are written concurrently, so the
 * graph tests cannot depend on a real handle. `bindTools` records the bound
 * tool names — that is how the tests read the handoff tool names the SDKs
 * actually generate instead of asserting on assumptions.
 */
export class FakeChatModel extends SimpleChatModel {
  readonly replies: FakeReply[];
  readonly agentName?: string;
  readonly boundToolNames: string[] = [];
  readonly boundToolDescriptions: string[] = [];
  calls = 0;

  constructor(fields: FakeChatModelFields) {
    super({});
    this.replies = fields.replies;
    this.agentName = fields.agentName;
  }

  override _llmType(): string {
    return 'agent-shell-fake';
  }

  // SimpleChatModel requires _call; this fake builds whole messages in _generate.
  override async _call(): Promise<string> {
    return '';
  }

  override bindTools(tools: BindToolsInput[]): this {
    for (const tool of tools) {
      if (typeof tool !== 'object' || tool === null) continue;
      const name = 'name' in tool ? tool.name : undefined;
      const description = 'description' in tool ? tool.description : undefined;
      if (typeof name === 'string') this.boundToolNames.push(name);
      if (typeof description === 'string') this.boundToolDescriptions.push(description);
    }
    return this;
  }

  override async _generate(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    // Strict on purpose: an incomplete script fails loudly instead of looping
    // on the last reply, which would surface only as a recursion-limit error.
    const reply = this.replies[this.calls];
    this.calls += 1;
    if (reply === undefined)
      throw new Error(`FakeChatModel(${this.agentName ?? 'unnamed'}) ran out of scripted replies`);
    if (typeof reply === 'string') {
      return {
        generations: [
          { text: reply, message: new AIMessage({ content: reply, name: this.agentName }) },
        ],
      };
    }
    return {
      generations: [
        {
          text: '',
          message: new AIMessage({
            content: '',
            name: this.agentName,
            tool_calls: reply.toolCalls,
          }),
        },
      ],
    };
  }
}

export function fakeModelHandle(
  model: SimpleChatModel,
  capabilities?: Partial<ProviderCapabilities>,
): ChatModelHandle {
  const base = DEFAULT_CAPABILITIES.scripted;
  return {
    providerId: 'scripted',
    modelId: 'fake',
    kind: 'scripted',
    capabilities: { ...base, ...capabilities },
    timeoutMs: 1_000,
    maxRetries: 0,
    model,
    invoke: async () => {
      throw new Error('FakeChatModel handle: graph code calls the wrapped model directly');
    },
    stream: () =>
      (async function* noText(): AsyncGenerator<string> {
        yield '';
      })(),
  };
}
