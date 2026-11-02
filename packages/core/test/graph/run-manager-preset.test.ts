import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import {
  rawConfigSchema,
  validateConfig,
  type ModelScript,
  type ResolvedConfig,
} from '../../src/config/schema.js';
import { defineTool, type ToolDefinition } from '../../src/tools/types.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { RunManager } from '../../src/runtime/run-manager.js';
import { makeTempWorkspace, type TempWorkspace } from '../../src/testing/index.js';
import { readTraceFile } from '../../src/events/reader.js';
import type { AgentEvent } from '../../src/events/schema.js';

const read = defineTool({
  name: 'read_file',
  description: 'Read a workspace file',
  schema: z.object({ path: z.string().min(1) }),
  risk: 'read',
  execute: async (args, ctx) => fs.readFileSync(ctx.resolveWorkspacePath(args.path), 'utf8'),
});

const write = defineTool({
  name: 'write_file',
  description: 'Write a workspace file',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  risk: 'write',
  execute: async (args, ctx) => {
    fs.writeFileSync(ctx.resolveWorkspacePath(args.path), args.content, 'utf8');
    return `wrote ${args.path}`;
  },
});

const usage = { inputTokens: 40, outputTokens: 10, totalTokens: 50 };

/** Per-agent scripts: `agent:<name>` keys let one scripted provider drive a team. */
function teamScripts(): Record<string, ModelScript> {
  return {
    'agent:lead': {
      version: 1,
      steps: [
        {
          toolCalls: [
            { name: 'transfer_to_researcher', args: { reason: 'needs reading' }, id: 'h1' },
          ],
        },
        // The supervisor is called a second time after the worker hands back.
        { content: 'lead: team finished: both notes summarised', usage },
      ],
    },
    'agent:researcher': {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r1' }], usage },
        { content: 'researcher: a.md says hello world', usage },
      ],
    },
    'agent:writer': {
      version: 1,
      steps: [{ content: 'writer: drafted the summary', usage }],
    },
  };
}

function buildConfig(
  preset: 'team' | 'swarm',
  scripts: Record<string, ModelScript>,
): ResolvedConfig {
  const presets =
    preset === 'team'
      ? {
          team: {
            kind: 'supervisor',
            supervisor: 'lead',
            agents: ['researcher', 'writer'],
            outputMode: 'full_history',
          },
        }
      : {
          swarm: {
            kind: 'swarm',
            agents: ['researcher', 'writer'],
            defaultActiveAgent: 'researcher',
          },
        };
  return validateConfig(
    rawConfigSchema.parse({
      providers: { mock: { kind: 'scripted', models: ['script'], scripts } },
      defaults: { provider: 'mock:script', preset, agent: 'lead' },
      tools: { code: [read, write] as unknown as ToolDefinition<never, never>[] },
      agents: {
        lead: { name: 'lead', prompt: 'Route work.', tools: [] },
        researcher: { name: 'researcher', prompt: 'Read files.', tools: ['read_file'] },
        writer: { name: 'writer', prompt: 'Write files.', tools: ['read_file', 'write_file'] },
      },
      presets,
    }),
  );
}

describe('RunManager multi-agent presets', () => {
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await makeTempWorkspace({ 'notes/a.md': 'hello world\n' });
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  async function run(
    preset: 'team' | 'swarm',
    task: string,
    sessionId: string,
    turn = 1,
  ): Promise<AgentEvent[]> {
    const scripts = teamScripts();
    if (preset === 'swarm') {
      scripts['agent:researcher'] = {
        version: 1,
        steps: [
          { toolCalls: [{ name: 'transfer_to_writer', args: { reason: 'handoff' }, id: 'h2' }] },
        ],
      };
      scripts['agent:writer'] = {
        version: 1,
        steps: [
          { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'w1' }], usage },
          { content: `writer: turn ${turn} summary`, usage },
        ],
      };
      scripts['agent:lead'] = { version: 1, steps: [{ content: 'unused' }] };
    }
    const config = buildConfig(preset, scripts);
    const registry = new ToolRegistry();
    registry.registerCode([read, write]);
    const manager = new RunManager({
      config,
      dataDir: path.join(workspace.dir, '.agent-shell'),
      workspaceRoot: workspace.dir,
      providers: createProviderRegistry(config),
      registry,
      interactive: true,
      checkpointer: new MemorySaver(),
    });
    const summary = await manager.startRun({
      task,
      preset,
      sessionId,
      ...(turn > 1 ? { resume: true } : {}),
    });
    return (await readTraceFile(summary.tracePath)).events;
  }

  it('supervisor routes to a worker and records the handoff', async () => {
    const events = await run('team', '总结两个文件', 'ses_team');
    const handoffs = events.filter((event) => event.type === 'subagent.handoff');
    expect(handoffs.length).toBeGreaterThan(0);
    expect((handoffs[0]?.payload as { to?: string }).to).toBe('researcher');
    const started = events.filter((event) => event.type === 'subagent.started');
    expect(
      started.some((event) => (event.payload as { pattern?: string }).pattern === 'supervisor'),
    ).toBe(true);
    expect(events.some((event) => event.type === 'subagent.finished')).toBe(true);
    expect(
      events.every(
        (event) => !event.type.startsWith('subagent') || event.parentSpanId !== undefined,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'tool.started' &&
          (event.payload as { name?: string }).name === 'read_file',
      ),
    ).toBe(true);
    const finished = events.find((event) => event.type === 'run.finished')?.payload as {
      status?: string;
      usage?: { totalTokens?: number };
    };
    expect(finished.status).toBe('ok');
    expect(finished.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('swarm hands off and keeps the active agent across turns', async () => {
    const first = await run('swarm', '先研究 notes/a.md', 'ses_swarm', 1);
    const handoffs = first.filter((event) => event.type === 'subagent.handoff');
    expect(handoffs.length).toBeGreaterThan(0);
    expect((handoffs[0]?.payload as { to?: string }).to).toBe('writer');
    expect(
      handoffs.some((event) => (event.payload as { pattern?: string }).pattern === 'swarm'),
    ).toBe(true);
    expect(
      first.some(
        (event) =>
          event.type === 'subagent.started' &&
          (event.payload as { pattern?: string }).pattern === 'swarm',
      ),
    ).toBe(true);

    const second = await run('swarm', '再写摘要', 'ses_swarm', 2);
    expect(second.some((event) => event.type === 'session.resumed')).toBe(true);
    expect(
      second.some(
        (event) =>
          event.type === 'run.finished' && (event.payload as { status?: string }).status === 'ok',
      ),
    ).toBe(true);
  });

  it('refuses to build a team graph without a checkpointer', async () => {
    const { buildSupervisorGraph } = await import('../../src/agents/supervisor.js');
    const config = buildConfig('team', teamScripts());
    const handle = await createProviderRegistry(config).create('mock:script', { agent: 'lead' });
    const spec = { name: 'lead', systemPrompt: 'p', model: handle, tools: [] };
    expect(() =>
      buildSupervisorGraph({
        supervisor: spec,
        workers: [{ ...spec, name: 'researcher' }],
        outputMode: 'full_history',
        checkpointer: undefined,
      }),
    ).toThrow(/checkpoint/i);
  });
});
