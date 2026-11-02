import { tool } from '@langchain/core/tools';
import { isAIMessage, type BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { buildSupervisorGraph } from '../../src/agents/supervisor.js';
import type { LeafAgentSpec } from '../../src/agents/react.js';
import { ConfigError } from '../../src/errors/index.js';
import { FakeChatModel, fakeModelHandle, type FakeReply } from './helpers/fake-model.js';

const echoTool = tool(async ({ text }) => `echo:${text}`, {
  name: 'echo_tool',
  description: 'Echo the given text back.',
  schema: z.object({ text: z.string() }),
});

function scripted(
  replies: FakeReply[],
  name?: string,
): { spec: LeafAgentSpec; model: FakeChatModel } {
  const model = new FakeChatModel({ replies, agentName: name });
  return {
    model,
    spec: {
      name: name ?? 'agent',
      systemPrompt: `You are ${name}.`,
      model: fakeModelHandle(model),
      tools: [],
    },
  };
}

function transferTo(agentName: string, callId: string): FakeReply {
  return {
    toolCalls: [{ name: `transfer_to_${agentName}`, args: {}, id: callId, type: 'tool_call' }],
  };
}

const thread = (id: string) => ({ configurable: { thread_id: id } });

/** A worker that first calls a real tool, then answers — so history depth is observable. */
function writingWorker(): LeafAgentSpec {
  const model = new FakeChatModel({
    replies: [
      { toolCalls: [{ name: 'echo_tool', args: { text: 'draft' }, id: 't1', type: 'tool_call' }] },
      'finished draft',
    ],
    agentName: 'writer',
  });
  return {
    name: 'writer',
    systemPrompt: 'You write.',
    model: fakeModelHandle(model),
    tools: [echoTool],
  };
}

describe('buildSupervisorGraph', () => {
  it('refuses to build without a checkpointer', () => {
    const supervisor = scripted(['done'], 'supervisor');
    const worker = scripted(['answer'], 'researcher');
    expect(() =>
      buildSupervisorGraph({
        supervisor: supervisor.spec,
        workers: [worker.spec],
        outputMode: 'last_message',
        checkpointer: undefined,
      }),
    ).toThrow(/checkpointer/i);
    expect(() =>
      buildSupervisorGraph({
        supervisor: supervisor.spec,
        workers: [worker.spec],
        outputMode: 'last_message',
        checkpointer: undefined,
      }),
    ).toThrow(ConfigError);
  });

  it('rejects an outputMode the upstream SDK does not accept', () => {
    const supervisor = scripted(['done'], 'supervisor');
    const worker = scripted(['answer'], 'researcher');
    expect(() =>
      buildSupervisorGraph({
        supervisor: supervisor.spec,
        workers: [worker.spec],
        // upstream OutputMode is exactly "full_history" | "last_message"
        outputMode: 'last_history' as never,
        checkpointer: new MemorySaver(),
      }),
    ).toThrow(ConfigError);
  });

  it('lists supervisor and worker node names and compiles with a checkpointer', async () => {
    const supervisor = scripted([transferTo('researcher', 'c1'), 'final'], 'supervisor');
    const worker = scripted(['42'], 'researcher');
    const { graph, agentNames } = buildSupervisorGraph({
      supervisor: supervisor.spec,
      workers: [worker.spec],
      outputMode: 'last_message',
      checkpointer: new MemorySaver(),
    });
    expect(agentNames).toEqual(['supervisor', 'researcher']);
    const nodes = graph.getGraph().nodes;
    expect(Object.keys(nodes).sort()).toEqual(['__start__', 'researcher', 'supervisor']);
  });

  it('generates one transfer_to_<worker> handoff tool per worker (real SDK names)', () => {
    const supervisor = scripted([transferTo('writer', 'c1'), 'final'], 'supervisor');
    const writer = scripted(['written'], 'writer');
    const reviewer = scripted(['reviewed'], 'reviewer');
    buildSupervisorGraph({
      supervisor: supervisor.spec,
      workers: [writer.spec, reviewer.spec],
      outputMode: 'last_message',
      checkpointer: new MemorySaver(),
    });
    expect(supervisor.model.boundToolNames).toContain('transfer_to_writer');
    expect(supervisor.model.boundToolNames).toContain('transfer_to_reviewer');
  });

  it('routes a task to the worker the supervisor transfers to and returns its answer', async () => {
    const supervisor = scripted([transferTo('writer', 'c1'), 'essay ready'], 'supervisor');
    const writer = scripted(['the essay'], 'writer');
    const other = scripted(['never used'], 'mathematician');
    const { graph } = buildSupervisorGraph({
      supervisor: supervisor.spec,
      workers: [writer.spec, other.spec],
      outputMode: 'last_message',
      checkpointer: new MemorySaver(),
    });

    const output = await graph.invoke(
      { messages: [{ role: 'user', content: 'write an essay' }] },
      thread('route'),
    );
    const messages = output.messages as BaseMessage[];
    expect(messages.at(-1)?.content).toBe('essay ready');
    expect(messages.some((message) => message.content === 'the essay')).toBe(true);
    expect(messages.some((message) => message.name === 'mathematician')).toBe(false);
    // The handoff itself is visible as a tool call on the supervisor's AI message.
    const handoffCalls = messages.flatMap((message) =>
      isAIMessage(message) ? (message.tool_calls ?? []).map((call) => call.name) : [],
    );
    expect(handoffCalls).toContain('transfer_to_writer');
  });

  it("full_history keeps the worker's intermediate tool messages, last_message keeps only its last", async () => {
    const fullHistory = buildSupervisorGraph({
      supervisor: scripted([transferTo('writer', 'c1'), 'done'], 'supervisor').spec,
      workers: [writingWorker()],
      outputMode: 'full_history',
      checkpointer: new MemorySaver(),
    });
    const fullOutput = await fullHistory.graph.invoke(
      { messages: [{ role: 'user', content: 'write' }] },
      thread('full'),
    );
    const fullMessages = fullOutput.messages as Array<{ content: unknown; name?: string }>;
    // full_history forwards the worker's whole message history, tool traffic included.
    expect(fullMessages.some((message) => message.name === 'echo_tool')).toBe(true);
    expect(fullMessages.some((message) => message.content === 'finished draft')).toBe(true);
    expect(fullMessages.at(-1)?.content).toBe('done');

    const lastMessage = buildSupervisorGraph({
      supervisor: scripted([transferTo('writer', 'c2'), 'done'], 'supervisor').spec,
      workers: [writingWorker()],
      outputMode: 'last_message',
      checkpointer: new MemorySaver(),
    });
    const lastOutput = await lastMessage.graph.invoke(
      { messages: [{ role: 'user', content: 'write' }] },
      thread('last'),
    );
    const lastMessages = lastOutput.messages as Array<{ content: unknown; name?: string }>;
    // last_message forwards only the worker's final message.
    expect(lastMessages.some((message) => message.name === 'echo_tool')).toBe(false);
    expect(lastMessages.some((message) => message.content === 'finished draft')).toBe(true);
    expect(lastMessages.at(-1)?.content).toBe('done');
  });

  it('surfaces a failing worker as a rejected run instead of hanging', async () => {
    const supervisor = scripted([transferTo('flaky', 'c1'), 'done'], 'supervisor');
    const flakyModel = new FakeChatModel({ replies: [], agentName: 'flaky' });
    const flaky: LeafAgentSpec = {
      name: 'flaky',
      systemPrompt: 'You fail.',
      model: fakeModelHandle(flakyModel),
      tools: [],
    };
    const { graph } = buildSupervisorGraph({
      supervisor: supervisor.spec,
      workers: [flaky],
      outputMode: 'last_message',
      checkpointer: new MemorySaver(),
    });
    await expect(
      graph.invoke({ messages: [{ role: 'user', content: 'go' }] }, thread('fail')),
    ).rejects.toThrow(/ran out of scripted replies/);
  });

  it("bakes recursionLimit into the compiled graph's default config", () => {
    const supervisor = scripted(['done'], 'supervisor');
    const worker = scripted(['done'], 'worker');
    const { graph } = buildSupervisorGraph({
      supervisor: supervisor.spec,
      workers: [worker.spec],
      outputMode: 'last_message',
      checkpointer: new MemorySaver(),
      recursionLimit: 7,
    });
    expect(graph.config?.recursionLimit).toBe(7);
  });
});
