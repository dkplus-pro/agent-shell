import type { StructuredToolInterface } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import type { ChatModelHandle } from '../providers/types.js';
import { ConfigError } from '../errors/index.js';

export interface LeafAgentSpec {
  name: string;
  systemPrompt: string;
  model: ChatModelHandle;
  tools: StructuredToolInterface[];
}

export interface LeafAgentOptions {
  maxSteps?: number;
}

/**
 * createReactAgent in @langchain/langgraph 1.6.0 exposes no maxIterations /
 * recursionLimit parameter — the step cap is a run-config option. Pregel keeps
 * a public `config` field of defaults which per-invocation config overrides, so
 * the budget declared with an agent is baked in there instead of being threaded
 * through every invoke call site.
 */
export function applyStepBudget(target: object, maxSteps: number | undefined): void {
  if (maxSteps === undefined) return;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new ConfigError(`maxSteps must be a positive integer, got ${maxSteps}.`);
  }
  const holder = target as { config?: Record<string, unknown> };
  holder.config = { ...(holder.config ?? {}), recursionLimit: maxSteps };
}

export function recursionLimitFor(target: object): number | undefined {
  const config = (target as { config?: { recursionLimit?: number } }).config;
  return config?.recursionLimit;
}

/**
 * createSupervisor copies `agent.description` into the worker's handoff-tool
 * description, so the leaf's system prompt (first line, capped) is the only
 * routing hint the supervisor's LLM gets about the worker.
 */
function descriptionOf(systemPrompt: string, maxChars = 200): string {
  const firstLine = systemPrompt.trim().split('\n', 1)[0] ?? '';
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars - 1)}…` : firstLine;
}

export function buildReactAgent(
  spec: LeafAgentSpec,
  opts?: LeafAgentOptions,
): ReturnType<typeof createReactAgent> {
  if (spec.name.trim().length === 0)
    throw new ConfigError('Leaf agent name must be a non-empty string.');
  if (opts?.maxSteps !== undefined && (!Number.isInteger(opts.maxSteps) || opts.maxSteps <= 0)) {
    throw new ConfigError(
      `Leaf agent ${spec.name}: maxSteps must be a positive integer, got ${opts.maxSteps}.`,
    );
  }
  const agent = createReactAgent({
    // supervisor and swarm both read `agent.name` to derive the node name and
    // the `transfer_to_<name>` handoff tool; an unnamed agent is rejected upstream.
    name: spec.name,
    description: descriptionOf(spec.systemPrompt),
    llm: spec.model.model,
    prompt: spec.systemPrompt,
    tools: spec.tools,
  });
  applyStepBudget(agent, opts?.maxSteps);
  return agent;
}
