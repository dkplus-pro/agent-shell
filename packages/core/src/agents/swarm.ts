import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createSwarm, createHandoffTool } from '@langchain/langgraph-swarm';
import { ConfigError } from '../errors/index.js';
import { applyStepBudget, buildReactAgent, type LeafAgentSpec } from './react.js';

/** State channel written by the swarm handoff tool (SwarmState in 1.0.4). */
export const SWARM_ACTIVE_AGENT_KEY = 'activeAgent' as const;

type CompiledSwarm = ReturnType<typeof compileSwarm>;

function compileSwarm(builder: ReturnType<typeof createSwarm>, checkpointer: BaseCheckpointSaver) {
  return builder.compile({ checkpointer });
}

export interface SwarmGraphOptions {
  agents: LeafAgentSpec[];
  defaultActiveAgent: string;
  /**
   * Mandatory by design (docs/01-architecture.md §5.6): `activeAgent` only
   * survives a turn — and only resumes across turns — through checkpoints.
   */
  checkpointer: BaseCheckpointSaver | undefined;
  handoffDescription?: (from: string, to: string) => string;
  recursionLimit?: number;
}

export interface BuiltSwarmGraph {
  graph: CompiledSwarm;
  agentNames: string[];
  activeAgentKey: typeof SWARM_ACTIVE_AGENT_KEY;
}

export function buildSwarmGraph(options: SwarmGraphOptions): BuiltSwarmGraph {
  if (options.checkpointer === undefined) {
    throw new ConfigError(
      'Swarm graphs require a checkpointer: pass one as SwarmGraphOptions.checkpointer ' +
        '(MemorySaver for tests, SqliteSaver for sessions). Without it the activeAgent channel cannot ' +
        'survive a turn and handoffs cannot be resumed.',
    );
  }
  if (options.agents.length < 2) {
    throw new ConfigError(`Swarm graphs need at least two agents, got ${options.agents.length}.`);
  }
  const agentNames = options.agents.map((agent) => assertUniqueAgentName(agent, options.agents));
  if (!agentNames.includes(options.defaultActiveAgent)) {
    throw new ConfigError(
      `defaultActiveAgent "${options.defaultActiveAgent}" is not one of the swarm agents (${agentNames.join(', ')}).`,
    );
  }

  // createSwarm does not wire handoffs itself: every agent must carry a
  // transfer_to_<other> tool, otherwise getHandoffDestinations() finds none and
  // the agent can never yield control. LeafAgentSpec.tools stays the *own*
  // tools, so the handoffs are added here in the adapter.
  const graphs = options.agents.map((agent) => {
    const handoffs = options.agents
      .filter((other) => other.name !== agent.name)
      .map((other) =>
        createHandoffTool({
          agentName: other.name,
          description: options.handoffDescription?.(agent.name, other.name),
        }),
      );
    return buildReactAgent({ ...agent, tools: [...agent.tools, ...handoffs] });
  });

  const builder = createSwarm({
    agents: graphs,
    defaultActiveAgent: options.defaultActiveAgent,
  });
  const graph = compileSwarm(builder, options.checkpointer);
  applyStepBudget(graph, options.recursionLimit);
  return { graph, agentNames, activeAgentKey: SWARM_ACTIVE_AGENT_KEY };
}

function assertUniqueAgentName(agent: LeafAgentSpec, all: LeafAgentSpec[]): string {
  if (agent.name.trim().length === 0)
    throw new ConfigError('Swarm agent name must be a non-empty string.');
  if (all.filter((other) => other.name === agent.name).length > 1) {
    throw new ConfigError(`Swarm agent name "${agent.name}" is declared more than once.`);
  }
  return agent.name;
}
