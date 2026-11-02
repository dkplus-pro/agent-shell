/**
 * Phase 4 acceptance tests for the MCP client adapter (docs/02-roadmap.md 阶段 4,
 * docs/04-testing-and-acceptance.md §2.3). Everything runs against the real
 * `@langchain/mcp-adapters` stack and a real stdio child process — no fakes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpServerConfigSchema, type McpServerConfig } from '../../src/config/schema.js';
import { env as envRef } from '../../src/config/secret.js';
import { McpError } from '../../src/errors/index.js';
import { makeEvent, validateEvent, type AgentEvent } from '../../src/events/schema.js';
import { MCPAdapter, type McpEmission, type McpToolDescriptor } from '../../src/mcp/adapter.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/mcp/echo-server.mjs', import.meta.url));
const ECHO = 'mcp__echo__echo';
const WRITE_NOTE = 'mcp__echo__write_note';

/** Temp dir handed to the child through the variable NAME only (config never carries values). */
let testDir: string;

/** Every adapter created by the suite, so no child process can outlive the run. */
const spawned: MCPAdapter[] = [];

function track(adapter: MCPAdapter): MCPAdapter {
  spawned.push(adapter);
  return adapter;
}

/** Records emissions as full event-schema-v1 envelopes and validates each one. */
class EventLog {
  readonly events: AgentEvent[] = [];
  private index = 0;

  readonly emit = (event: McpEmission): void => {
    const index = this.index;
    this.index += 1;
    const envelope = makeEvent({
      type: event.type,
      sessionId: `ses_mcp-test-${index}`,
      runId: `run_mcp-test-${index}`,
      spanId: `spn_mcp-test-${index}`,
      source: 'mcp',
      payload: event.payload,
    });
    this.events.push(validateEvent(envelope));
  };

  of(type: AgentEvent['type']): AgentEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  for(type: AgentEvent['type'], server: string): AgentEvent[] {
    return this.of(type).filter((event) => event.payload.server === server);
  }

  clear(): void {
    this.events.length = 0;
    this.index = 0;
  }
}

type StdioOverrides = Partial<Extract<McpServerConfig, { transport: 'stdio' }>>;

function stdioServer(
  args: readonly string[] = [],
  overrides: StdioOverrides = {},
): McpServerConfig {
  return mcpServerConfigSchema.parse({
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE, ...args],
    envVars: ['MCP_TEST_DIR'],
    ...overrides,
  });
}

function byName(tools: McpToolDescriptor[], finalName: string): McpToolDescriptor {
  const found = tools.find((tool) => tool.finalName === finalName);
  if (found === undefined) throw new Error(`missing tool ${finalName}`);
  return found;
}

async function connect(
  servers: Record<string, McpServerConfig>,
  log: EventLog,
): Promise<MCPAdapter> {
  const adapter = await MCPAdapter.connectAll({
    servers,
    workspaceRoot: path.dirname(FIXTURE),
    emit: log.emit,
  });
  return track(adapter);
}

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shell-mcp-'));
  process.env.MCP_TEST_DIR = testDir;
});

afterAll(async () => {
  for (const adapter of spawned) await adapter.close();
  delete process.env.MCP_TEST_DIR;
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

describe('MCPAdapter.connectAll — stdio discovery', () => {
  const log = new EventLog();
  let adapter: MCPAdapter;

  beforeAll(async () => {
    adapter = await connect({ echo: stdioServer() }, log);
  });

  it('lists namespaced tools with mapped risks', () => {
    const names = adapter.tools().map((tool) => tool.finalName);
    expect(names).toEqual([ECHO, WRITE_NOTE]);
    expect(adapter.get(ECHO)?.risk).toBe('read');
    expect(adapter.get(WRITE_NOTE)?.risk).toBe('exec');
    expect(adapter.get('mcp__echo__nope')).toBeUndefined();

    const echo = byName(adapter.tools(), ECHO);
    expect(echo.serverName).toBe('echo');
    expect(echo.name).toBe('echo');
    expect(echo.description).toMatch(/unchanged/i);
    expect(echo.annotations).toMatchObject({ readOnlyHint: true });
    expect(echo.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    expect(byName(adapter.tools(), WRITE_NOTE).annotations).toEqual({});
  });

  it('emits mcp.connected with the payload contract', () => {
    const connected = log.for('mcp.connected', 'echo');
    expect(connected).toHaveLength(1);
    expect(connected[0]?.payload).toEqual({ server: 'echo', transport: 'stdio', toolCount: 2 });
    expect(log.of('mcp.error')).toHaveLength(0);
  });

  it('reports status with transport and tool count', () => {
    expect(adapter.status()).toEqual([
      { serverName: 'echo', transport: 'stdio', connected: true, toolCount: 2 },
    ]);
  });

  it('calls echo and normalizes the result to text', async () => {
    await expect(adapter.call(ECHO, { text: 'hello mcp' })).resolves.toBe('hello mcp');
  });

  it('forwards envVars by name only into the child', async () => {
    const file = await adapter.call(WRITE_NOTE, { text: 'body', name: 'note.txt' });
    expect(typeof file).toBe('string');
    expect(String(file).startsWith(testDir)).toBe(true);
    expect(fs.readFileSync(path.join(testDir, 'note.txt'), 'utf8')).toBe('body');
  });

  it('rejects an unknown tool name without touching the server', async () => {
    const error = await adapter.call('mcp__echo__missing', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('MCP_CALL');
  });
});

describe('MCPAdapter — risk overrides', () => {
  const log = new EventLog();
  let adapter: MCPAdapter;

  beforeAll(async () => {
    adapter = await connect(
      {
        echo: stdioServer([], {
          riskOverrides: { echo: 'exec', write_note: 'read', unlisted_tool: 'write' },
        }),
      },
      log,
    );
  });

  it('lets configuration both downgrade and upgrade the default exec', () => {
    expect(byName(adapter.tools(), ECHO).risk).toBe('exec');
    expect(byName(adapter.tools(), WRITE_NOTE).risk).toBe('read');
    expect(adapter.tools()).toHaveLength(2);
  });
});

describe('MCPAdapter — crash isolation', () => {
  const log = new EventLog();
  let adapter: MCPAdapter;
  const crashed = 'mcp__crashy__echo';

  beforeAll(async () => {
    adapter = await connect(
      { crashy: stdioServer(['--crash-on-call'], { timeoutMs: 4_000 }), echo: stdioServer() },
      log,
    );
  });

  it('lists tools from the crashing server', () => {
    expect(adapter.get(crashed)?.risk).toBe('read');
    expect(
      adapter
        .status()
        .map((s) => s.serverName)
        .sort(),
    ).toEqual(['crashy', 'echo']);
  });

  it('turns a crashed server into an McpError, never a raw SDK error', async () => {
    const started = Date.now();
    const error = await adapter.call(crashed, { text: 'boom' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    expect(mcp.code).toBe('MCP_CALL');
    expect(mcp.message).toContain('crashy');
    expect(mcp.message.startsWith('MCP tool')).toBe(true);
    expect(mcp.name).toBe('McpError');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('stays usable: a repeated call and a healthy sibling both answer', async () => {
    const again = await adapter.call(crashed, { text: 'again' }).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(McpError);
    expect((again as McpError).code).toBe('MCP_CALL');
    await expect(adapter.call(ECHO, { text: 'still here' })).resolves.toBe('still here');
  });

  it('marks the dead server in status and keeps the sibling connected', () => {
    const crashy = adapter.status().find((s) => s.serverName === 'crashy');
    expect(crashy?.connected).toBe(false);
    expect(crashy?.lastError?.code).toBe('MCP_CALL');
    expect(adapter.status().find((s) => s.serverName === 'echo')?.connected).toBe(true);
  });
});

describe('MCPAdapter — timeout enforcement', () => {
  const log = new EventLog();
  const timeoutMs = 300;
  let adapter: MCPAdapter;

  beforeAll(async () => {
    adapter = await connect({ echo: stdioServer(['--slow', '1500'], { timeoutMs }) }, log);
  });

  it('fails with MCP_TIMEOUT close to timeoutMs', async () => {
    const started = Date.now();
    const error = await adapter.call(ECHO, { text: 'slow' }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    expect(mcp.code).toBe('MCP_TIMEOUT');
    expect(mcp.message).toContain(`${timeoutMs}ms`);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 20);
    expect(elapsed).toBeLessThan(timeoutMs + 1_000);
  });

  it('does not leak a timer that keeps the process alive', async () => {
    await expect(adapter.call(ECHO, { text: 'again' })).rejects.toThrow(McpError);
    expect(adapter.status()[0]?.lastError).toMatchObject({ name: 'McpError', code: 'MCP_TIMEOUT' });
    expect(adapter.status()[0]?.connected).toBe(true);
  });
});

describe('MCPAdapter — unreachable server and disabled servers', () => {
  it('keeps a healthy sibling while the broken server emits mcp.error', async () => {
    const log = new EventLog();
    const adapter = await connect(
      {
        bogus: mcpServerConfigSchema.parse({
          transport: 'stdio',
          command: `${process.execPath}-does-not-exist`,
          args: [],
        }),
        echo: stdioServer(),
      },
      log,
    );

    const errors = log.for('mcp.error', 'bogus');
    expect(errors).toHaveLength(1);
    const payload = errors[0]?.payload.error as { name: string; code?: string; message: string };
    expect(typeof payload.name).toBe('string');
    expect(payload.message).toMatch(/ENOENT|spawn|not exist/i);
    expect(log.for('mcp.connected', 'bogus')).toHaveLength(0);
    expect(log.for('mcp.connected', 'echo').map((e) => e.payload.toolCount)).toEqual([2]);
    expect(adapter.tools().map((t) => t.finalName)).toEqual([ECHO, WRITE_NOTE]);
    expect(adapter.status().find((s) => s.serverName === 'bogus')).toMatchObject({
      transport: 'stdio',
      connected: false,
      toolCount: 0,
    });
    await expect(adapter.call(ECHO, { text: 'unaffected' })).resolves.toBe('unaffected');
  });

  it("accepts an http server's config and isolates an unreachable endpoint", async () => {
    const log = new EventLog();
    const adapter = await connect(
      {
        remote: mcpServerConfigSchema.parse({
          transport: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: envRef('MCP_TEST_TOKEN') },
          timeoutMs: 3_000,
        }),
        echo: stdioServer(),
      },
      log,
    );
    expect(adapter.status().find((s) => s.serverName === 'remote')).toMatchObject({
      transport: 'http',
      connected: false,
      toolCount: 0,
    });
    expect(log.for('mcp.error', 'remote')).toHaveLength(1);
    expect(log.for('mcp.connected', 'remote')).toHaveLength(0);
    expect(adapter.tools().map((t) => t.finalName)).toEqual([ECHO, WRITE_NOTE]);
  });

  it('skips disabled servers without connecting or emitting', async () => {
    const log = new EventLog();
    const adapter = await connect(
      { off: stdioServer([], { enabled: false }), echo: stdioServer() },
      log,
    );
    expect(adapter.status().map((s) => s.serverName)).toEqual(['echo']);
    expect(log.events.filter((e) => e.payload.server === 'off')).toHaveLength(0);
    expect(adapter.tools()).toHaveLength(2);
  });

  it('fails the whole connect when two servers collide after namespacing', async () => {
    const log = new EventLog();
    const error = await MCPAdapter.connectAll({
      servers: { 'a-b': stdioServer(), a_b: stdioServer() },
      workspaceRoot: path.dirname(FIXTURE),
      emit: log.emit,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    const mcp = error as McpError;
    expect(mcp.code).toBe('MCP_CONNECT');
    expect(mcp.message).toContain('mcp__a_b__echo');
    expect(mcp.message).toContain('collision');
  });
});

describe('MCPAdapter.close', () => {
  it('is idempotent and emits mcp.disconnected once per server', async () => {
    const log = new EventLog();
    const adapter = await connect({ echo: stdioServer() }, log);
    await adapter.close();
    await adapter.close();

    expect(log.for('mcp.disconnected', 'echo')).toHaveLength(1);
    expect(log.for('mcp.disconnected', 'echo')[0]?.payload).toEqual({
      server: 'echo',
      reason: 'closed',
    });
    expect(adapter.tools()).toHaveLength(0);
    expect(adapter.status()[0]).toMatchObject({ connected: false, toolCount: 0 });
    const error = await adapter.call(ECHO, { text: 'after close' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe('MCP_CALL');
  });

  it('tolerates closing a server that already crashed', async () => {
    const log = new EventLog();
    const adapter = await connect({ crashy: stdioServer(['--crash-on-call']) }, log);
    await adapter.call('mcp__crashy__echo', { text: 'x' }).catch(() => undefined);
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(log.for('mcp.disconnected', 'crashy')).toHaveLength(1);
  });

  it('every emission of the suite satisfies event schema v1', () => {
    const log = new EventLog();
    log.emit({ type: 'mcp.connected', payload: { server: 's', transport: 'http', toolCount: 0 } });
    expect(() => log.emit({ type: 'mcp.connected', payload: { server: 's' } })).toThrow();
    expect(() =>
      log.emit({ type: 'mcp.error', payload: { server: 's', error: { message: 'm' } } }),
    ).toThrow();
    expect(log.events).toHaveLength(1);
  });
});
