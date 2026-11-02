import { MemorySaver } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { SWARM_ACTIVE_AGENT_KEY, buildSwarmGraph } from '../../src/agents/swarm.js';
import type { LeafAgentSpec } from '../../src/agents/react.js';
import { ConfigError } from '../../src/errors/index.js';
import { FakeChatModel, fakeModelHandle, type FakeReply } from './helpers/fake-model.js';

function agent(name: string, replies: FakeReply[]): { spec: LeafAgentSpec; model: FakeChatModel } {
  const model = new FakeChatModel({ replies, agentName: name });
  return {
    model,
    spec: { name, systemPrompt: `You are ${name}.`, model: fakeModelHandle(model), tools: [] },
  };
}

function transferTo(agentName: string, callId: string): FakeReply {
  return {
    toolCalls: [{ name: `transfer_to_${agentName}`, args: {}, id: callId, type: 'tool_call' }],
  };
}

const thread = (id: string) => ({ configurable: { thread_id: id } });

describe('buildSwarmGraph', () => {
  it('refuses to build without a checkpointer', () => {
    const alpha = agent('alpha', ['ok']);
    const beta = agent('beta', ['ok']);
    expect(() =>
      buildSwarmGraph({
        agents: [alpha.spec, beta.spec],
        defaultActiveAgent: 'alpha',
        checkpointer: undefined,
      }),
    ).toThrow(ConfigError);
    expect(() =>
      buildSwarmGraph({
        agents: [alpha.spec, beta.spec],
        defaultActiveAgent: 'alpha',
        checkpointer: undefined,
      }),
    ).toThrow(/checkpointer/i);
  });

  it('rejects a defaultActiveAgent that is not one of the agents', () => {
    const alpha = agent('alpha', ['ok']);
    const beta = agent('beta', ['ok']);
    expect(() =>
      buildSwarmGraph({
        agents: [alpha.spec, beta.spec],
        defaultActiveAgent: 'ghost',
        checkpointer: new MemorySaver(),
      }),
    ).toThrow(ConfigError);
  });

  it('wires a transfer_to_<peer> handoff tool into every agent (real SDK names)', async () => {
    const alpha = agent('alpha', [transferTo('beta', 'c1')]);
    const beta = agent('beta', ['handled']);
    const { graph, agentNames, activeAgentKey } = buildSwarmGraph({
      agents: [alpha.spec, beta.spec],
      defaultActiveAgent: 'alpha',
      checkpointer: new MemorySaver(),
    });
    expect(agentNames).toEqual(['alpha', 'beta']);
    expect(activeAgentKey).toBe(SWARM_ACTIVE_AGENT_KEY);
    // createReactAgent binds tools lazily, so the observable names require a run.
    await graph.invoke({ messages: [{ role: 'user', content: 'start' }] }, thread('names'));
    expect(alpha.model.boundToolNames).toContain('transfer_to_beta');
    expect(beta.model.boundToolNames).toContain('transfer_to_alpha');
    // Upstream default description when the adapter supplies none.
    expect(alpha.model.boundToolDescriptions).toContain("Ask agent 'beta' for help");
  });

  it('honours handoffDescription for the transfer tool', async () => {
    const alpha = agent('alpha', [transferTo('beta', 'c1')]);
    const beta = agent('beta', ['handled']);
    const { graph } = buildSwarmGraph({
      agents: [alpha.spec, beta.spec],
      defaultActiveAgent: 'alpha',
      checkpointer: new MemorySaver(),
      handoffDescription: (from, to) => `${from}->${to}`,
    });
    await graph.invoke({ messages: [{ role: 'user', content: 'start' }] }, thread('desc'));
    expect(alpha.model.boundToolNames).toContain('transfer_to_beta');
    expect(alpha.model.boundToolDescriptions).toContain('alpha->beta');
  });

  it('transfers control and records the new activeAgent', async () => {
    const alpha = agent('alpha', [transferTo('beta', 'c1')]);
    const beta = agent('beta', ['beta handled it']);
    const { graph } = buildSwarmGraph({
      agents: [alpha.spec, beta.spec],
      defaultActiveAgent: 'alpha',
      checkpointer: new MemorySaver(),
    });

    const output = await graph.invoke(
      { messages: [{ role: 'user', content: 'need the specialist' }] },
      thread('s1'),
    );
    expect(output[SWARM_ACTIVE_AGENT_KEY]).toBe('beta');
    const messages = output.messages as BaseMessage[];
    expect(messages.at(-1)?.content).toBe('beta handled it');
  });

  it('keeps the active agent on the next turn of the same thread', async () => {
    const alpha = agent('alpha', [transferTo('beta', 'c1'), 'alpha again']);
    const beta = agent('beta', ['beta turn 1', 'beta turn 2']);
    const { graph } = buildSwarmGraph({
      agents: [alpha.spec, beta.spec],
      defaultActiveAgent: 'alpha',
      checkpointer: new MemorySaver(),
    });

    const first = await graph.invoke(
      { messages: [{ role: 'user', content: 'start' }] },
      thread('s2'),
    );
    expect(first[SWARM_ACTIVE_AGENT_KEY]).toBe('beta');

    const second = await graph.invoke(
      { messages: [{ role: 'user', content: 'continue' }] },
      thread('s2'),
    );
    expect(second[SWARM_ACTIVE_AGENT_KEY]).toBe('beta');
    const messages = second.messages as BaseMessage[];
    expect(messages.at(-1)?.content).toBe('beta turn 2');
    expect(alpha.model.calls).toBe(1);
  });

  it('routes a fresh thread to defaultActiveAgent without writing activeAgent (upstream behaviour)', async () => {
    const alpha = agent('alpha', ['alpha answered']);
    const beta = agent('beta', ['beta answered']);
    const { graph } = buildSwarmGraph({
      agents: [alpha.spec, beta.spec],
      defaultActiveAgent: 'beta',
      checkpointer: new MemorySaver(),
    });
    const output = await graph.invoke(
      { messages: [{ role: 'user', content: 'hi' }] },
      thread('s3'),
    );
    const messages = output.messages as BaseMessage[];
    expect(messages.at(-1)?.content).toBe('beta answered');
    expect(messages.at(-1)?.name).toBe('beta');
    expect(alpha.model.calls).toBe(0);
    // DOCUMENTED UPSTREAM BEHAVIOUR (langgraph-swarm 1.0.4): the `activeAgent`
    // channel is only written by a handoff tool. A turn that never hands off
    // leaves it unset — addActiveAgentRouter falls back to defaultActiveAgent
    // at routing time. The RunManager must therefore read the active agent as
    // `state.activeAgent ?? defaultActiveAgent`.
    expect(output[SWARM_ACTIVE_AGENT_KEY]).toBeUndefined();
    const snapshot = await graph.getState(thread('s3'));
    expect(snapshot.values[SWARM_ACTIVE_AGENT_KEY]).toBeUndefined();
  });

  it('surfaces a failing agent as a rejected run', async () => {
    const alpha = agent('alpha', [transferTo('beta', 'c1')]);
    const beta = agent('beta', []);
    const { graph } = buildSwarmGraph({
      agents: [alpha.spec, beta.spec],
      defaultActiveAgent: 'alpha',
      checkpointer: new MemorySaver(),
    });
    await expect(
      graph.invoke({ messages: [{ role: 'user', content: 'go' }] }, thread('s4')),
    ).rejects.toThrow(/ran out of scripted replies/);
  });
});
