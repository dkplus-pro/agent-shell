import { MemorySaver } from '@langchain/langgraph';
import { isAIMessage, type BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import {
  HANDOFF_BACK_TOOL_PREFIX,
  HANDOFF_TOOL_PREFIX,
  classifyHandoffToolName,
  handoffEventInput,
} from '../../src/agents/handoff.js';
import { buildSupervisorGraph } from '../../src/agents/supervisor.js';
import { buildSwarmGraph } from '../../src/agents/swarm.js';
import type { LeafAgentSpec } from '../../src/agents/react.js';
import { makeEvent, validateEvent } from '../../src/events/schema.js';
import { FakeChatModel, fakeModelHandle, type FakeReply } from './helpers/fake-model.js';

function scripted(
  name: string,
  replies: FakeReply[],
): { spec: LeafAgentSpec; model: FakeChatModel } {
  const model = new FakeChatModel({ replies, agentName: name });
  return {
    model,
    spec: { name, systemPrompt: `You are ${name}.`, model: fakeModelHandle(model), tools: [] },
  };
}

/** Tool-call names carried by the graph's message history (AIMessage.tool_calls). */
function toolCallNames(messages: BaseMessage[]): string[] {
  return messages.flatMap((message) =>
    isAIMessage(message) ? (message.tool_calls ?? []).map((call) => call.name) : [],
  );
}

const transferTo = (agentName: string, id: string): FakeReply => ({
  toolCalls: [{ name: `${HANDOFF_TOOL_PREFIX}${agentName}`, args: {}, id, type: 'tool_call' }],
});

/** Every tool call name the two graph shapes actually emitted. */
async function observedSupervisorHandoffNames(): Promise<string[]> {
  const supervisor = scripted('supervisor', [
    transferTo('writer', 'c1'),
    transferTo('code_reviewer', 'c2'),
    'done',
  ]);
  const writer = scripted('writer', ['written']);
  // An uppercase display name on purpose: the SDK normalises it into the tool name.
  const reviewerModel = new FakeChatModel({ replies: ['reviewed'], agentName: 'Code Reviewer' });
  const reviewer: LeafAgentSpec = {
    name: 'Code Reviewer',
    systemPrompt: 'You review.',
    model: fakeModelHandle(reviewerModel),
    tools: [],
  };
  const { graph } = buildSupervisorGraph({
    supervisor: supervisor.spec,
    workers: [writer.spec, reviewer],
    outputMode: 'full_history',
    checkpointer: new MemorySaver(),
  });
  const output = await graph.invoke(
    { messages: [{ role: 'user', content: 'write then review' }] },
    { configurable: { thread_id: 'h-sup' } },
  );
  return toolCallNames(output.messages as BaseMessage[]);
}

async function observedSwarmHandoffNames(): Promise<string[]> {
  const alpha = scripted('alpha', [transferTo('beta', 'c1')]);
  const beta = scripted('beta', ['handled']);
  const { graph } = buildSwarmGraph({
    agents: [alpha.spec, beta.spec],
    defaultActiveAgent: 'alpha',
    checkpointer: new MemorySaver(),
  });
  const output = await graph.invoke(
    { messages: [{ role: 'user', content: 'go' }] },
    { configurable: { thread_id: 'h-swarm' } },
  );
  return toolCallNames(output.messages as BaseMessage[]);
}

describe('handoff tool naming (observed from compiled graphs)', () => {
  it('recognises the names the supervisor graph emits', async () => {
    const names = await observedSupervisorHandoffNames();
    expect(names).toContain('transfer_to_writer');
    expect(names).toContain('transfer_to_code_reviewer');
    expect(names).toContain('transfer_back_to_supervisor');
    for (const name of names) expect(classifyHandoffToolName(name, 'supervisor')).toBeDefined();
    expect(classifyHandoffToolName('transfer_to_code_reviewer')).toEqual({
      pattern: 'swarm',
      to: 'code_reviewer',
    });
    expect(classifyHandoffToolName('transfer_to_code_reviewer', 'supervisor')).toEqual({
      pattern: 'supervisor',
      to: 'code_reviewer',
    });
    expect(classifyHandoffToolName(`${HANDOFF_BACK_TOOL_PREFIX}supervisor`)).toEqual({
      pattern: 'supervisor',
      to: 'supervisor',
    });
  });

  it('recognises the names the swarm graph emits', async () => {
    const names = await observedSwarmHandoffNames();
    expect(names).toEqual(['transfer_to_beta']);
    expect(classifyHandoffToolName(names[0] ?? '')).toEqual({ pattern: 'swarm', to: 'beta' });
  });

  it('leaves ordinary tool calls alone', () => {
    expect(classifyHandoffToolName('read_file')).toBeUndefined();
    expect(classifyHandoffToolName('transfer_to_')).toBeUndefined();
    expect(classifyHandoffToolName('')).toBeUndefined();
    expect(handoffEventInput('bash', 'alpha')).toBeUndefined();
  });

  it('maps a handoff call onto a schema-valid subagent.handoff payload', () => {
    const payload = handoffEventInput('transfer_to_writer', 'supervisor', {
      pattern: 'supervisor',
      reason: 'needs prose',
    });
    expect(payload).toEqual({
      from: 'supervisor',
      to: 'writer',
      reason: 'needs prose',
      pattern: 'supervisor',
    });
    if (payload === undefined) throw new Error('expected a handoff payload');
    const event = makeEvent({
      type: 'subagent.handoff',
      sessionId: 'ses_test',
      runId: 'run_test',
      spanId: 'spn_test',
      source: 'graph',
      payload,
    });
    expect(() => validateEvent(event)).not.toThrow();

    const minimal = handoffEventInput('transfer_to_beta', 'alpha');
    expect(minimal).toEqual({ from: 'alpha', to: 'beta', pattern: 'swarm' });
    if (minimal === undefined) throw new Error('expected a handoff payload');
    expect(
      makeEvent({
        type: 'subagent.handoff',
        sessionId: 'ses_t',
        runId: 'run_t',
        spanId: 'spn_t',
        source: 'graph',
        payload: minimal,
      }).payload,
    ).toEqual(minimal);
  });

  it('drops an empty reason so the strict payload schema stays minimal', () => {
    expect(handoffEventInput('transfer_to_beta', 'alpha', { reason: '' })).toEqual({
      from: 'alpha',
      to: 'beta',
      pattern: 'swarm',
    });
  });
});
