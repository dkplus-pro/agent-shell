import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, NameConflictError, UnknownToolError } from '../../src/errors/index.js';
import type { Risk } from '../../src/events/schema.js';
import { mcpToolName, pluginToolName, runtimeToolName } from '../../src/tools/naming.js';
import { ToolRegistry, type McpToolInput, type RegistrableTool } from '../../src/tools/registry.js';
import {
  defineTool,
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from '../../src/tools/types.js';

function testCtx(): ToolContext {
  return {
    sessionId: 'ses_test',
    runId: 'run_test',
    spanId: 'spn_test',
    callId: 'call_test',
    toolName: 'read_file',
    signal: new AbortController().signal,
    workspaceRoot: '/tmp/workspace',
    allowOutsideWorkspace: false,
    log: () => {},
    resolveWorkspacePath: (input: string) => input,
  };
}

function toolDef(overrides: Partial<RegistrableTool> = {}): RegistrableTool {
  return {
    name: 'read_file',
    description: 'Read a file',
    schema: z.object({ path: z.string() }),
    risk: 'read',
    execute: async (): Promise<ToolOutput> => 'ok',
    ...overrides,
  };
}

function mcpTool(overrides: Partial<McpToolInput> = {}): McpToolInput {
  return {
    name: 'search',
    description: 'Search the index',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'text to look for' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    },
    call: async (args: Record<string, unknown>): Promise<ToolOutput> => ({
      echoed: JSON.stringify(args),
    }),
    ...overrides,
  };
}

describe('ToolRegistry.registerCode', () => {
  it('stores a code tool with resolved defaults', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef()]);
    expect(store.size()).toBe(1);
    expect(store.has('read_file')).toBe(true);
    const entry = store.get('read_file');
    expect(entry.source).toBe('code');
    expect(entry.risk).toBe('read');
    expect(entry.timeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(entry.idempotent).toBe(false);
    expect(entry.origin).toEqual({ kind: 'code' });
    expect(entry.pluginName).toBeUndefined();
    expect(entry.serverName).toBeUndefined();
    expect(store.names()).toEqual(['read_file']);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps a declared timeout and idempotency flag', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef({ timeoutMs: 5_000, idempotent: true })]);
    expect(store.get('read_file').timeoutMs).toBe(5_000);
    expect(store.get('read_file').idempotent).toBe(true);
  });

  it('accepts both concrete and never-typed ToolDefinition values', () => {
    const concrete: ToolDefinition<{ path: string }, string> = defineTool({
      name: 'read_file',
      description: 'Read a file',
      schema: z.object({ path: z.string() }),
      risk: 'read',
      execute: async (args: { path: string }): Promise<string> => args.path,
    });
    const store = new ToolRegistry();
    store.registerCode([concrete]);
    expect(store.get('read_file').name).toBe('read_file');

    // config and plugin manifests hand over ToolDefinition<never, never>; the two
    // argument/result types do not structurally overlap, so erase via `unknown`.
    const erased = concrete as unknown as ToolDefinition<never, never>;
    expect(() => new ToolRegistry().registerCode([erased])).not.toThrow();
  });

  it('rejects names that violate the tool name pattern', () => {
    const store = new ToolRegistry();
    expect(() => store.registerCode([toolDef({ name: 'Read_File' })])).toThrow(ConfigError);
    expect(() => store.registerCode([toolDef({ name: 'read-file' })])).toThrow(/Invalid tool name/);
    expect(() => store.registerCode([toolDef({ name: '' })])).toThrow(ConfigError);
    expect(store.size()).toBe(0);
  });

  it('rejects reserved namespaces for code tools', () => {
    for (const name of [
      pluginToolName('files', 'read'),
      mcpToolName('docs', 'search'),
      runtimeToolName('spawn'),
    ]) {
      expect(() => new ToolRegistry().registerCode([toolDef({ name })])).toThrow(ConfigError);
      expect(() => new ToolRegistry().registerCode([toolDef({ name })])).toThrow(
        /reserved namespace/,
      );
    }
  });

  it('rejects a duplicate name with NameConflictError', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef()]);
    expect(() => store.registerCode([toolDef({ description: 'again' })])).toThrow(
      NameConflictError,
    );
    expect(() => store.registerCode([toolDef()])).toThrow(/registered twice/);
    expect(store.size()).toBe(1);
  });

  it('honours an external reservation', () => {
    const store = new ToolRegistry();
    expect(() =>
      store.registerCode([toolDef()], { reserve: (name) => name === 'read_file' }),
    ).toThrow(NameConflictError);
    expect(store.size()).toBe(0);
    expect(
      store.registerCode([toolDef({ name: 'write_file' })], { reserve: () => false }),
    ).toBeUndefined();
  });

  it('requires an explicit risk level', () => {
    expect(() => new ToolRegistry().registerCode([toolDef({ risk: undefined })])).toThrow(
      /must declare a risk/,
    );
    expect(() =>
      new ToolRegistry().registerCode([toolDef({ risk: 'danger' as unknown as Risk })]),
    ).toThrow(ConfigError);
  });

  it('rejects malformed definitions', () => {
    expect(() => new ToolRegistry().registerCode([toolDef({ description: '   ' })])).toThrow(
      /non-empty description/,
    );
    expect(() =>
      new ToolRegistry().registerCode([
        { ...toolDef(), execute: undefined as unknown as RegistrableTool['execute'] },
      ]),
    ).toThrow(/execute\(\) handler/);
    expect(() =>
      new ToolRegistry().registerCode([{ ...toolDef(), schema: {} as z.ZodTypeAny }]),
    ).toThrow(/zod schema/);
    expect(() => new ToolRegistry().registerCode([toolDef({ timeoutMs: 0 })])).toThrow(/timeoutMs/);
  });
});

describe('ToolRegistry.registerPlugin', () => {
  it('namespaces plugin tools and returns the registered entries', () => {
    const store = new ToolRegistry();
    const added = store.registerPlugin('files', [
      toolDef({ name: 'read_note', risk: 'read' }),
      toolDef({ name: 'write_note', risk: 'write' }),
    ]);
    expect(added.map((entry) => entry.name)).toEqual([
      'plugin__files__read_note',
      'plugin__files__write_note',
    ]);
    expect(added[0]?.pluginName).toBe('files');
    expect(added[1]?.risk).toBe('write');
    expect(added[1]?.source).toBe('plugin');
    expect(added[1]?.origin).toEqual({ kind: 'plugin', plugin: 'files', tool: 'write_note' });
    expect(store.get('plugin__files__read_note').source).toBe('plugin');
  });

  it('normalises plugin and tool segments', () => {
    const store = new ToolRegistry();
    const [entry] = store.registerPlugin('My Plugin', [toolDef({ name: 'Do Thing' })]);
    expect(entry?.name).toBe('plugin__my_plugin__do_thing');
  });

  it('refuses a plugin tool without a risk', () => {
    expect(() =>
      new ToolRegistry().registerPlugin('files', [toolDef({ risk: undefined })]),
    ).toThrow(ConfigError);
  });

  it('refuses colliding plugin tools', () => {
    const store = new ToolRegistry();
    store.registerPlugin('files', [toolDef({ name: 'read_note' })]);
    expect(() => store.registerPlugin('files', [toolDef({ name: 'read_note' })])).toThrow(
      NameConflictError,
    );
    expect(() =>
      store.registerPlugin('files', [
        toolDef({ name: 'read_note' }),
        toolDef({ name: 'read_note' }),
      ]),
    ).toThrow(NameConflictError);
  });

  it('cannot collide with a code tool because namespaces are reserved', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef({ name: 'read_file' })]);
    const added = store.registerPlugin('files', [toolDef({ name: 'read_file' })]);
    expect(added[0]?.name).toBe('plugin__files__read_file');
    expect(store.size()).toBe(2);
  });
});

describe('ToolRegistry.registerMcp', () => {
  it('defaults untrusted MCP tools to exec and namespaces them', () => {
    const store = new ToolRegistry();
    const [entry] = store.registerMcp('docs', [mcpTool()]);
    expect(entry?.name).toBe('mcp__docs__search');
    expect(entry?.risk).toBe('exec');
    expect(entry?.source).toBe('mcp');
    expect(entry?.serverName).toBe('docs');
    expect(entry?.timeoutMs).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(entry?.origin).toEqual({ kind: 'mcp', server: 'docs', tool: 'search' });
  });

  it('downgrades readOnlyHint to read, but only when it is exactly true', () => {
    const store = new ToolRegistry();
    const [readOnly] = store.registerMcp('docs', [
      mcpTool({ annotations: { readOnlyHint: true } }),
    ]);
    expect(readOnly?.risk).toBe('read');
    const [hinted] = store.registerMcp('other', [
      mcpTool({ annotations: { readOnlyHint: false } }),
    ]);
    expect(hinted?.risk).toBe('exec');
    const [noAnnotation] = store.registerMcp('third', [mcpTool()]);
    expect(noAnnotation?.risk).toBe('exec');
  });

  it('applies configured risk overrides', () => {
    const store = new ToolRegistry();
    const [entry] = store.registerMcp('docs', [mcpTool({ annotations: { readOnlyHint: true } })], {
      search: 'write',
    });
    expect(entry?.risk).toBe('write');
    expect(() =>
      store.registerMcp('other', [mcpTool()], { search: 'safe' as unknown as Risk }),
    ).toThrow(ConfigError);
  });

  it('converts the MCP inputSchema into a zod schema that validates args', () => {
    const store = new ToolRegistry();
    const [entry] = store.registerMcp('docs', [
      mcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'text' },
            limit: { type: 'integer' },
            mode: { type: 'string', enum: ['fast', 'deep'] },
            tags: { type: 'array', items: { type: 'string' } },
            meta: { type: 'object' },
            anything: {},
          },
          required: ['query', 'mode'],
        },
      }),
    ]);
    const schema = entry?.schema;
    expect(schema?.safeParse({ query: 'x', mode: 'fast' }).success).toBe(true);
    expect(
      schema?.safeParse({
        query: 'x',
        mode: 'fast',
        limit: 3,
        tags: ['a'],
        meta: { k: 1 },
        anything: 7,
      }).success,
    ).toBe(true);
    expect(schema?.safeParse({ mode: 'fast' }).success).toBe(false);
    expect(schema?.safeParse({ query: 'x', mode: 'slow' }).success).toBe(false);
    expect(schema?.safeParse({ query: 'x', mode: 'fast', limit: 'many' }).success).toBe(false);
    expect(schema?.safeParse({ query: 'x', mode: 'fast', unexpected: true }).success).toBe(true);
  });

  it('tolerates an empty or weird inputSchema', () => {
    const store = new ToolRegistry();
    const [entry] = store.registerMcp('docs', [mcpTool({ inputSchema: {} })]);
    expect(entry?.schema.safeParse({ any: 'thing' }).success).toBe(true);
  });

  it('routes execute() through the adapter call', async () => {
    const calls: Array<{ args: Record<string, unknown>; tool: string }> = [];
    const store = new ToolRegistry();
    const [entry] = store.registerMcp('docs', [
      mcpTool({
        call: async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> => {
          calls.push({ args, tool: ctx.toolName });
          return 'done';
        },
      }),
    ]);
    await expect(entry?.execute({ query: 'x', mode: 'fast' } as never, testCtx())).resolves.toBe(
      'done',
    );
    expect(calls).toEqual([{ args: { query: 'x', mode: 'fast' }, tool: 'read_file' }]);
  });

  it('rejects malformed MCP metadata and name collisions', () => {
    expect(() => new ToolRegistry().registerMcp('docs', [mcpTool({ name: '' })])).toThrow(
      ConfigError,
    );
    expect(() =>
      new ToolRegistry().registerMcp('docs', [
        mcpTool({ description: undefined as unknown as string }),
      ]),
    ).toThrow(/description/);
    expect(() =>
      new ToolRegistry().registerMcp('docs', [
        mcpTool({ inputSchema: undefined as unknown as Record<string, unknown> }),
      ]),
    ).toThrow(/inputSchema/);
    expect(() =>
      new ToolRegistry().registerMcp('docs', [
        mcpTool({ call: undefined as unknown as McpToolInput['call'] }),
      ]),
    ).toThrow(/call\(\)/);
    const store = new ToolRegistry();
    store.registerMcp('docs', [mcpTool()]);
    expect(() => store.registerMcp('docs', [mcpTool()])).toThrow(NameConflictError);
    expect(store.size()).toBe(1);
  });
});

describe('ToolRegistry.registerRuntime', () => {
  it('namespaces runtime tools', () => {
    const store = new ToolRegistry();
    const entry = store.registerRuntime(toolDef({ name: 'spawn_subagent', risk: 'write' }));
    expect(entry.name).toBe('runtime__spawn_subagent');
    expect(entry.source).toBe('runtime');
    expect(entry.origin).toEqual({ kind: 'runtime', tool: 'spawn_subagent' });
    expect(() => store.registerRuntime(toolDef({ name: 'spawn_subagent', risk: 'write' }))).toThrow(
      NameConflictError,
    );
    expect(() => store.registerRuntime(toolDef({ name: 'abort_run', risk: undefined }))).toThrow(
      ConfigError,
    );
  });
});

describe('ToolRegistry lookups', () => {
  it('throws UnknownToolError for missing names', () => {
    const store = new ToolRegistry();
    expect(() => store.get('nope')).toThrow(UnknownToolError);
    expect(() => store.get('nope')).toThrow(/Unknown tool/);
    expect(store.has('nope')).toBe(false);
    expect(store.list()).toEqual([]);
    expect(store.names()).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('filters by source', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef()]);
    store.registerPlugin('files', [toolDef({ name: 'note' })]);
    store.registerMcp('docs', [mcpTool()]);
    store.registerRuntime(toolDef({ name: 'spawn_subagent', risk: 'write' }));
    expect(store.list({ source: 'plugin' }).map((entry) => entry.name)).toEqual([
      'plugin__files__note',
    ]);
    expect(store.list({ source: 'mcp' }).map((entry) => entry.name)).toEqual(['mcp__docs__search']);
    expect(store.list({ source: 'code' })).toHaveLength(1);
    expect(store.list({ source: 'runtime' })).toHaveLength(1);
    expect(store.list({ source: 'runtime' })[0]?.origin.kind).toBe('runtime');
    expect(store.size()).toBe(4);
  });

  it('builds an isolated subset and reports missing names', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef(), toolDef({ name: 'write_file', risk: 'write' })]);
    store.registerMcp('docs', [mcpTool()]);

    const subset = store.subset(['read_file', 'mcp__docs__search', 'ghost_tool']);
    expect(subset).not.toBe(store);
    expect(subset.names()).toEqual(['read_file', 'mcp__docs__search']);
    expect(subset.missing).toEqual(['ghost_tool']);
    expect(subset.size()).toBe(2);
    expect(subset.get('read_file').source).toBe('code');
    expect(() => subset.get('ghost_tool')).toThrow(UnknownToolError);

    expect(store.size()).toBe(3);
    expect(store.missing).toEqual([]);
  });

  it('reports every unknown name requested by an allowlist', () => {
    const store = new ToolRegistry();
    store.registerCode([toolDef()]);
    const subset = store.subset(['read_file', 'a', 'b']);
    expect(subset.missing).toEqual(['a', 'b']);
    subset.missing.push('c');
    expect(subset.missing).toEqual(['a', 'b']);
  });
});
