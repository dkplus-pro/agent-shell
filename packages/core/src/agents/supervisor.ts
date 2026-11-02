import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createSupervisor } from '@langchain/langgraph-supervisor';
import { ConfigError } from '../errors/index.js';
import { applyStepBudget, buildReactAgent, type LeafAgentSpec } from './react.js';

/**
 * Real accepted values in @langchain/langgraph-supervisor 1.1.3
 * (`type OutputMode = "full_history" | "last_message"`, default `"last_message"`).
 * There is no `"last_history"` mode.
 */
export type SupervisorOutputMode = 'full_history' | 'last_message';

const OUTPUT_MODES: readonly SupervisorOutputMode[] = ['full_history', 'last_message'];

/** Compiled by this adapter; inferred from the real compile call site. */
function compileSupervisor(
  builder: ReturnType<typeof createSupervisor>,
  checkpointer: BaseCheckpointSaver,
) {
  return builder.compile({ checkpointer });
}

type CompiledSupervisor = ReturnType<typeof compileSupervisor>;

export interface SupervisorGraphOptions {
  supervisor: LeafAgentSpec;
  workers: LeafAgentSpec[];
  outputMode: SupervisorOutputMode;
  /**
   * Mandatory by design (docs/01-architecture.md §5.6): without a checkpointer
   * a supervisor thread cannot be resumed, and the handoff `Command({ graph: PARENT })`
   * jumps are built on persisted message history.
   */
  checkpointer: BaseCheckpointSaver | undefined;
  recursionLimit?: number;
}

export interface BuiltSupervisorGraph {
  graph: CompiledSupervisor;
  agentNames: string[];
}

export function buildSupervisorGraph(options: SupervisorGraphOptions): BuiltSupervisorGraph {
  if (options.checkpointer === undefined) {
    throw new ConfigError(
      'Supervisor graphs require a checkpointer: pass one as SupervisorGraphOptions.checkpointer ' +
        '(MemorySaver for tests, SqliteSaver for sessions). Without it a supervisor thread cannot be ' +
        'resumed and handoff commands lose the message history they are built on.',
    );
  }
  if (!OUTPUT_MODES.includes(options.outputMode)) {
    throw new ConfigError(
      `Invalid supervisor outputMode "${options.outputMode}": expected one of ${OUTPUT_MODES.join(', ')}.`,
    );
  }
  if (options.workers.length === 0) {
    throw new ConfigError('Supervisor graphs need at least one worker agent.');
  }
  const workerNames = options.workers.map((worker) =>
    assertUniqueWorkerName(worker, options.supervisor.name),
  );

  // createSupervisor returns an uncompiled StateGraph, so compile — and with it
  // the mandatory checkpointer — is applied here, the only place we can enforce it.
  const builder = createSupervisor({
    agents: options.workers.map((worker) => buildReactAgent(worker)),
    llm: options.supervisor.model.model,
    prompt: options.supervisor.systemPrompt,
    supervisorName: options.supervisor.name,
    outputMode: options.outputMode,
    includeAgentName: 'inline',
  });
  const graph = compileSupervisor(builder, options.checkpointer);
  applyStepBudget(graph, options.recursionLimit);
  return { graph, agentNames: [options.supervisor.name, ...workerNames] };
}

function assertUniqueWorkerName(worker: LeafAgentSpec, supervisorName: string): string {
  if (worker.name.trim().length === 0)
    throw new ConfigError('Worker agent name must be a non-empty string.');
  if (worker.name === supervisorName) {
    throw new ConfigError(`Worker agent name "${worker.name}" collides with the supervisor name.`);
  }
  return worker.name;
}
