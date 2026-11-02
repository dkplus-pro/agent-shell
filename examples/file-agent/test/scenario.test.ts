/**
 * Scenario integrity tests for the only reference example in the repo
 * (docs/00-requirements.md FR-13, docs/04-testing-and-acceptance.md §4.1).
 *
 * They run without the CLI: the combination root validates, the business tools
 * are well-formed, the plugin manifest is legal, the two offline script files
 * match their documented shapes, every tool name the model script speaks exists
 * under the documented namespacing rules, and the MCP server really serves its
 * two tools over stdio.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  modelScriptSchema,
  rawConfigSchema,
  validateConfig,
  type ResolvedConfig,
} from '../../../packages/core/src/config/schema.js';
import { loadConfig } from '../../../packages/core/src/config/loader.js';
import { TOOL_RISKS, type Risk } from '../../../packages/core/src/events/schema.js';
import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
} from '../../../packages/core/src/plugins/api.js';
import {
  TOOL_NAME_PATTERN,
  assertToolName,
  mcpToolName,
  pluginToolName,
  runtimeToolName,
} from '../../../packages/core/src/tools/naming.js';
import { ToolRegistry } from '../../../packages/core/src/tools/registry.js';
import type { ToolContext } from '../../../packages/core/src/tools/types.js';
import configDefault from '../agent-shell.config.js';
import { readFileTool } from '../tools/read-file.js';
import { runShellTool, tokenizeCommand } from '../tools/run-shell.js';
import { writeFileTool } from '../tools/write-file.js';

const exampleDir = path.dirname(fileURLToPath(import.meta.url));
const scenarioDir = path.resolve(exampleDir, '..');
const serverPath = path.join(scenarioDir, 'mcp-echo-server', 'server.mjs');

/** Final namespaced names the runtime produces (docs/01 §5.4). */
const WORD_COUNT_TOOL = pluginToolName('word-count', 'word_count');
const ECHO_TOOL = mcpToolName('echo', 'echo');
const WRITE_NOTE_TOOL = mcpToolName('echo', 'write_note');
const SPAWN_TOOL = runtimeToolName('spawn_subagent');

const temporaryDirs: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

function resolved(): ResolvedConfig {
  return validateConfig(rawConfigSchema.parse(configDefault));
}

function stdioServer(config: ResolvedConfig): {
  command: string;
  args: string[];
  envVars: string[];
} {
  const server = config.mcp.servers['echo'];
  if (server === undefined) throw new Error('mcp.servers.echo must exist');
  if (server.transport !== 'stdio') throw new Error('mcp.servers.echo must be stdio');
  return { command: server.command, args: server.args, envVars: server.envVars };
}

/** A stand-in for the runtime context; the path stub enforces the same boundary. */
function toolContext(workspaceRoot: string, toolName = 'test'): ToolContext {
  return {
    sessionId: 'ses_test',
    runId: 'run_test',
    spanId: 'spn_test',
    callId: 'call_test',
    toolName,
    signal: new AbortController().signal,
    workspaceRoot,
    allowOutsideWorkspace: false,
    log: () => {},
    resolveWorkspacePath(input: string): string {
      const resolved = path.resolve(workspaceRoot, input);
      if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
        throw new Error(`WorkspaceBoundaryError: "${input}" escapes the workspace root`);
      }
      return resolved;
    },
  };
}

function envForChild(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...extra };
}

describe('agent-shell.config.ts is a valid combination root', () => {
  it('passes rawConfigSchema and validateConfig', () => {
    const parsed = rawConfigSchema.parse(configDefault);
    expect(() => validateConfig(parsed)).not.toThrow();
    const config = parsed;

    expect(Object.keys(config.providers).sort()).toEqual(['anthropic', 'openai']);
    expect(config.providers['openai']?.kind).toBe('scripted');
    expect(config.providers['anthropic']?.kind).toBe('scripted');
    expect(config.defaults.provider).toBe('openai:fake');
    // Memory checkpointer keeps Acts deterministic (docs/04 §4.1).
    expect(config.checkpointer).toBe('memory');
    expect(Object.keys(config.presets).sort()).toEqual(['single', 'swarm', 'team']);
    expect(Object.keys(config.agents).sort()).toEqual(['default', 'lead', 'researcher', 'writer']);
    expect(config.tools.code.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'run_shell',
    ]);
  });

  it("loads through core's loader (jiti), exactly as the CLI does", async () => {
    const loaded = await loadConfig(path.join(scenarioDir, 'agent-shell.config.ts'));
    expect(loaded.baseDir).toBe(scenarioDir);
    expect(loaded.config.tools.code.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'run_shell',
    ]);
    expect(stdioServer(loaded.config).args).toEqual(['./mcp-echo-server/server.mjs']);
  });

  it('wires all three tool sources without risk overrides', () => {
    const config = resolved();
    expect(stdioServer(config).command).toBe('node');
    expect(stdioServer(config).envVars).toEqual(['MCP_TEST_DIR']);
    expect(config.mcp.servers['echo']?.riskOverrides).toEqual({});
    expect(config.plugins.dirs).toEqual(['./plugins']);
    expect(config.plugins.enabled).toBe(true);
  });

  it('gives researcher read-only tools and writer read+write', () => {
    const config = resolved();
    expect(config.agents.researcher?.tools).toEqual(['read_file']);
    expect(config.agents.writer?.tools).toEqual(['read_file', 'write_file']);
    expect(config.agents.lead?.tools).toEqual(['read_file']);
    // An empty allowlist means "the whole registry": Acts 2/3 need plugin and
    // MCP tools, and agent allowlists may not name namespaced tools.
    expect(config.agents.default?.tools).toEqual([]);

    const team = config.presets['team'];
    if (team?.kind !== 'supervisor') throw new Error('presets.team must be a supervisor preset');
    expect(team.supervisor).toBe('lead');
    expect(team.agents).toEqual(['researcher', 'writer']);

    const swarm = config.presets['swarm'];
    if (swarm?.kind !== 'swarm') throw new Error('presets.swarm must be a swarm preset');
    expect(swarm.agents).toEqual(['researcher', 'writer']);
    expect(swarm.defaultActiveAgent).toBe('researcher');
  });

  it('keeps secrets out of the scenario files', async () => {
    const files = [
      'agent-shell.config.ts',
      'model.script.json',
      'scenario.acceptance.json',
      'plugins/word-count/plugin.json',
      'plugins/word-count/entry.mjs',
      'mcp-echo-server/server.mjs',
    ];
    for (const relative of files) {
      const text = await readFile(path.join(scenarioDir, relative), 'utf8');
      // A key is an `env("NAME")` reference, never a literal (AGENT.md §5).
      expect(text, relative).not.toMatch(/apiKey\s*:\s*["'`]/);
      expect(text, relative).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
      expect(text, relative).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/);
    }
  });
});

describe('code tools live in the example, not in core', () => {
  const tools = [readFileTool, writeFileTool, runShellTool] as const;

  it('declares a legal name, a mandatory risk and a zod schema', () => {
    for (const tool of tools) {
      expect(() => assertToolName(tool.name)).not.toThrow();
      expect(TOOL_NAME_PATTERN.test(tool.name), tool.name).toBe(true);
      expect((TOOL_RISKS as readonly string[]).includes(tool.risk), tool.risk).toBe(true);
      expect(tool.description.trim().length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.schema.safeParse).toBe('function');
      expect(tool.schema.safeParse({}).success).toBe(false);
    }
  });

  it('matches the risk tiers of docs/01 §5.5', () => {
    const risk = (tool: { risk: Risk }): Risk => tool.risk;
    expect(risk(readFileTool)).toBe('read');
    expect(risk(writeFileTool)).toBe('write');
    // exec: two confirmations, and the second one must be the word `run`.
    expect(risk(runShellTool)).toBe('exec');
  });

  it('validates arguments before touching a file or a process', () => {
    expect(readFileTool.schema.safeParse({ path: 'notes/a.md' }).success).toBe(true);
    expect(writeFileTool.schema.safeParse({ path: 'notes/a.md' }).success).toBe(false);
    expect(writeFileTool.schema.safeParse({ path: 'notes/a.md', content: 'x' }).success).toBe(true);
    expect(runShellTool.schema.safeParse({ command: 'echo hello' }).success).toBe(true);
    expect(runShellTool.schema.safeParse({ command: '' }).success).toBe(false);
  });

  it('tokenizes into an argv array and rejects shell syntax', () => {
    expect(tokenizeCommand('echo hello')).toEqual({ program: 'echo', args: ['hello'] });
    expect(tokenizeCommand("echo 'two words'")).toEqual({ program: 'echo', args: ['two words'] });
    expect(tokenizeCommand('echo done\n')).toEqual({ program: 'echo', args: ['done'] });
    expect(() => tokenizeCommand('echo hi; rm -rf /')).toThrow(/metacharacters/);
    expect(() => tokenizeCommand('echo $(whoami)')).toThrow(/metacharacters/);
    expect(() => tokenizeCommand('echo "unterminated')).toThrow(/unterminated quote/);
    expect(() => tokenizeCommand('   ')).toThrow(/empty command/);
  });

  it('spawns only the allowlisted program, never a shell', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'file-agent-shell-tool-'));
    temporaryDirs.push(workspace);

    const ctx = toolContext(workspace);
    await expect(runShellTool.execute({ command: 'echo hello' }, ctx)).resolves.toMatchObject({
      stdout: 'hello\n',
      exitCode: 0,
    });
    // `ls` parses fine but is not on the allowlist, so it is never spawned.
    await expect(runShellTool.execute({ command: 'ls -la' }, ctx)).rejects.toThrow(
      /not allowlisted/,
    );
  });

  it('stays inside the workspace boundary', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'file-agent-guard-'));
    temporaryDirs.push(workspace);
    await mkdir(path.join(workspace, 'notes'), { recursive: true });
    await writeFile(path.join(workspace, 'notes', 'a.md'), 'hello world');
    await writeFile(path.join(workspace, 'blocked'), 'a file where a directory is expected');

    const ctx = toolContext(workspace);
    await expect(readFileTool.execute({ path: 'notes/a.md' }, ctx)).resolves.toBe('hello world');
    await expect(readFileTool.execute({ path: 'blocked/inner.md' }, ctx)).rejects.toThrow();
    await expect(readFileTool.execute({ path: '../../etc/passwd' }, ctx)).rejects.toThrow(
      /workspace root/,
    );
    await expect(
      writeFileTool.execute({ path: '../escape.md', content: 'x' }, ctx),
    ).rejects.toThrow(/workspace root/);

    await expect(
      writeFileTool.execute({ path: 'notes/new/deep.md', content: 'written' }, ctx),
    ).resolves.toMatchObject({ bytesWritten: 7 });
    await expect(readFileTool.execute({ path: 'notes/new/deep.md' }, ctx)).resolves.toBe('written');
  });
});

describe('word-count plugin fixture (docs/04 §2.4)', () => {
  const pluginDir = path.join(scenarioDir, 'plugins', 'word-count');

  it('has a manifest that passes pluginManifestSchema with the current apiVersion', async () => {
    const manifest = pluginManifestSchema.parse(
      await readJson(path.join(pluginDir, 'plugin.json')),
    );
    expect(manifest.name).toBe('word-count');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(manifest.entry).toBe('entry.mjs');
    expect(existsSync(path.join(pluginDir, manifest.entry))).toBe(true);
    expect(existsSync(path.join(pluginDir, 'README.md'))).toBe(true);
  });

  it('registers exactly one read-risk tool named word_count', async () => {
    const entry = await readFile(path.join(pluginDir, 'entry.mjs'), 'utf8');
    const names = [...entry.matchAll(/name:\s*['"]([a-z0-9_]+)['"]/g)].map((match) => match[1] ?? '');
    expect(names).toEqual(['word_count']);
    expect(entry).toMatch(/risk:\s*['"]read['"]/);
    expect(entry).not.toMatch(/risk:\s*['"](write|exec)['"]/);
    expect(entry).toContain('definePlugin');
    // Plugins import the documented plugin entry point, never core internals.
    expect(entry).toContain('@agent-shell/core/plugin');
    expect(entry).not.toContain('packages/core/src');
  });

  it('keeps the counting logic pure and testable', async () => {
    const href = pathToFileURL(path.join(pluginDir, 'count-words.mjs')).href;
    const counter = (await import(/* @vite-ignore */ href)) as unknown as {
      countWords: (text: string) => number;
      countLines: (text: string) => number;
      measure: (text: string) => {
        words: number;
        lines: number;
        characters: number;
        bytes: number;
      };
    };
    expect(counter.countWords('hello world')).toBe(2);
    expect(counter.countWords('agent shell')).toBe(2);
    expect(counter.countWords('')).toBe(0);
    expect(counter.countLines('a\nb c\n')).toBe(2);
    expect(counter.measure('hello world')).toMatchObject({ words: 2, characters: 11, bytes: 11 });
  });
});

describe('offline script files (docs/03 §5, docs/04 §2.1)', () => {
  const turnSchema = z
    .object({
      input: z.string().min(1),
      expect: z
        .object({
          contains: z.string().min(1).optional(),
          exitCode: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict();

  const approvalSchema = z
    .object({
      tool: z.string().regex(TOOL_NAME_PATTERN),
      decision: z.enum(['approve', 'deny']),
      confirmation: z.string().min(1).optional(),
      argsMatch: z.record(z.string(), z.unknown()).optional(),
      occurrence: z.number().int().positive().optional(),
    })
    .strict();

  const scenarioSchema = z
    .object({
      version: z.literal(1),
      provider: z.string().regex(/^[a-z0-9_-]+(:[A-Za-z0-9._[\]-]+)?$/i),
      preset: z.string().min(1),
      turns: z.array(turnSchema).min(1),
      approvals: z.array(approvalSchema).default([]),
    })
    .strict();

  // One documented script object, or a list of them when Act groups need a
  // different provider/preset (Acts 7-9).
  const scenarioFileSchema = z.union([scenarioSchema, z.array(scenarioSchema).min(1)]);

  async function scenarios(): Promise<z.output<typeof scenarioSchema>[]> {
    const parsed = scenarioFileSchema.parse(
      await readJson(path.join(scenarioDir, 'scenario.acceptance.json')),
    );
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async function script() {
    return modelScriptSchema.parse(await readJson(path.join(scenarioDir, 'model.script.json')));
  }

  it('model.script.json is a version 1 ModelScript', async () => {
    const model = await script();
    expect(model.version).toBe(1);
    expect(model.steps.length).toBeGreaterThanOrEqual(13);
    expect(model.steps.some((step) => step.streamChunks !== undefined)).toBe(true);
    expect(model.steps.some((step) => step.usage !== undefined)).toBe(true);
    // Per-agent steps let one file drive Acts 6-9 (docs/04 §2.1).
    expect(model.steps.some((step) => step.agent === 'researcher')).toBe(true);
    for (const [index, step] of model.steps.entries()) {
      const doesSomething =
        step.content !== undefined ||
        step.toolCalls !== undefined ||
        step.streamChunks !== undefined ||
        step.error !== undefined;
      expect(doesSomething, `step ${String(index)}`).toBe(true);
    }
  });

  it('scenario.acceptance.json matches the documented scripted-mode shape', async () => {
    const entries = await scenarios();
    const config = resolved();
    const providers = entries.map((entry) => entry.provider);
    const presets = entries.map((entry) => entry.preset);

    for (const entry of entries) {
      expect(entry.version).toBe(1);
      const providerId = entry.provider.split(':')[0] ?? entry.provider;
      expect(Object.hasOwn(config.providers, providerId), entry.provider).toBe(true);
      expect(Object.hasOwn(config.presets, entry.preset), entry.preset).toBe(true);
    }
    expect(providers).toContain('openai:fake');
    expect(providers).toContain('anthropic:fake');
    expect(presets).toEqual(expect.arrayContaining(['single', 'team', 'swarm']));
    // Acts 1-6 run as one conversation.
    expect(entries[0]?.turns.length).toBe(6);
  });

  it('approves one write and two-step exec, and only risks that need it', async () => {
    const entries = await scenarios();
    const approvals = entries.flatMap((entry) => entry.approvals);
    const config = resolved();

    const writeApprovals = approvals.filter(
      (approval) => approval.tool === 'write_file' && approval.decision === 'approve',
    );
    expect(writeApprovals.length).toBeGreaterThan(0);
    for (const approval of writeApprovals) {
      // docs/03 §3.1: write is a single confirmation, so no second word.
      expect(approval.confirmation).toBeUndefined();
    }

    const execApprovals = approvals.filter((approval) => approval.tool === 'run_shell');
    expect(execApprovals.length).toBeGreaterThan(0);
    for (const approval of execApprovals) {
      if (approval.decision === 'approve') {
        // docs/03 §3.2: the second exec confirmation is the literal `run`.
        expect(approval.confirmation).toBe('run');
      }
      expect(approval.argsMatch?.['command']).toBe('echo hello');
    }

    for (const approval of approvals) {
      const tool = config.tools.code.find((candidate) => candidate.name === approval.tool);
      expect(tool?.risk === 'write' || tool?.risk === 'exec', approval.tool).toBe(true);
    }
  });

  it('only expects answers the model script can produce', async () => {
    const entries = await scenarios();
    const model = await script();
    const corpus = model.steps.map((step) => step.content ?? '').join('\n');
    for (const entry of entries) {
      for (const turn of entry.turns) {
        const expected = turn.expect?.contains;
        if (expected === undefined) continue;
        expect(corpus, `${entry.preset} :: ${turn.input}`).toContain(expected);
      }
    }
  });
});

describe('tool names referenced by the model script (docs/01 §5.4)', () => {
  const registry = new ToolRegistry();
  registry.registerCode([readFileTool, writeFileTool, runShellTool]);

  it("registers the config's code tools with source, risk and timeout", () => {
    expect(registry.names().sort()).toEqual(['read_file', 'run_shell', 'write_file']);
    expect(registry.get('read_file').source).toBe('code');
    expect(registry.get('write_file').risk).toBe('write');
    expect(registry.get('run_shell').risk).toBe('exec');
    expect(registry.get('read_file').timeoutMs).toBeGreaterThan(0);
    expect(registry.subset(['read_file']).names()).toEqual(['read_file']);
  });

  it('namespaces plugin, MCP and runtime tools by the documented rules', () => {
    expect(WORD_COUNT_TOOL).toBe('plugin__word_count__word_count');
    expect(ECHO_TOOL).toBe('mcp__echo__echo');
    expect(WRITE_NOTE_TOOL).toBe('mcp__echo__write_note');
    expect(SPAWN_TOOL).toBe('runtime__spawn_subagent');
  });

  it('references only tools this scenario provides', async () => {
    const model = await modelScriptSchema.parse(
      await readJson(path.join(scenarioDir, 'model.script.json')),
    );
    const available = new Set<string>([
      ...registry.names(),
      WORD_COUNT_TOOL,
      ECHO_TOOL,
      WRITE_NOTE_TOOL,
      SPAWN_TOOL,
    ]);
    const referenced = new Set<string>();
    for (const step of model.steps) {
      for (const call of step.toolCalls ?? []) referenced.add(call.name);
    }
    expect([...referenced].sort()).toEqual(
      [ECHO_TOOL, SPAWN_TOOL, WORD_COUNT_TOOL, 'read_file', 'run_shell', 'write_file'].sort(),
    );
    for (const name of referenced) {
      expect(available.has(name), name).toBe(true);
      expect(() => assertToolName(name)).not.toThrow();
    }
  });

  it('validates the scripted arguments against the real schemas', async () => {
    const model = await modelScriptSchema.parse(
      await readJson(path.join(scenarioDir, 'model.script.json')),
    );
    const calls = model.steps.flatMap((step) => step.toolCalls ?? []);
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const call of calls) {
      if (call.name === 'read_file')
        expect(readFileTool.schema.safeParse(call.args).success, call.id).toBe(true);
      if (call.name === 'write_file')
        expect(writeFileTool.schema.safeParse(call.args).success, call.id).toBe(true);
      if (call.name === 'run_shell') {
        expect(runShellTool.schema.safeParse(call.args).success, call.id).toBe(true);
        const command = call.args['command'];
        if (typeof command === 'string') {
          expect(tokenizeCommand(command).program).toBe('echo');
        }
      }
      if (call.name === WORD_COUNT_TOOL) expect(typeof call.args['path']).toBe('string');
      if (call.name === SPAWN_TOOL) expect(call.args['agent']).toBe('researcher');
    }
  });

  it('reads the fixture files the scenario documents', async () => {
    const workspace = path.join(scenarioDir, 'workspace');
    expect(await readFile(path.join(workspace, 'notes', 'a.md'), 'utf8')).toBe('hello world');
    expect(await readFile(path.join(workspace, 'notes', 'b.md'), 'utf8')).toBe('agent shell');
    const model = await modelScriptSchema.parse(
      await readJson(path.join(scenarioDir, 'model.script.json')),
    );
    const readPaths = model.steps
      .flatMap((step) => step.toolCalls ?? [])
      .filter((call) => call.name === 'read_file')
      .map((call) => call.args['path']);
    for (const relative of readPaths) {
      if (typeof relative !== 'string') throw new Error('read_file path must be a string');
      expect(existsSync(path.join(workspace, relative)), relative).toBe(true);
    }
  });
});

describe('mcp-echo-server (docs/04 §2.3)', () => {
  let workspace = '';

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'file-agent-mcp-'));
    temporaryDirs.push(workspace);
  });

  it('--help prints usage and exits 0', async () => {
    const result = await runServer(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: node server.mjs');
    expect(result.stdout).toContain('write_note');
    expect(result.stdout).toContain('crash');
  });

  it('exits cleanly when stdin closes', async () => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: scenarioDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();
    expect(await exitedWith(child, 15_000)).toBe(0);
    expect(stderr).toContain('[mcp-echo] ready');
    expect(stderr).toContain('shutting down');
  });

  it('serves echo read-only and write_note unannotated', async () => {
    const noteDir = path.join(workspace, 'notes');
    const client = await connectServer(noteDir, []);
    try {
      const listed = await client.listTools();
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
      expect([...byName.keys()].sort()).toEqual(['echo', 'write_note']);
      // readOnlyHint is what lets the adapter downgrade `echo` to risk read.
      expect(byName.get('echo')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('write_note')?.annotations).toBeUndefined();
      expect(byName.get('echo')?.inputSchema).toMatchObject({ type: 'object', required: ['text'] });

      const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hello from mcp' } });
      expect(textOf(echoed.content)).toBe('hello from mcp');

      const written = await client.callTool({
        name: 'write_note',
        arguments: { name: 'note.txt', content: 'agent shell' },
      });
      expect(textOf(written.content)).toContain('note.txt');
      expect(await readFile(path.join(noteDir, 'note.txt'), 'utf8')).toBe('agent shell');

      const escaped = await client.callTool({
        name: 'write_note',
        arguments: { name: '../outside.txt', content: 'no' },
      });
      expect(textOf(escaped.content)).toContain('outside.txt');
      expect(existsSync(path.join(workspace, 'outside.txt'))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('refuses write_note when MCP_TEST_DIR is unset', async () => {
    const client = await connectServer('', []);
    try {
      const result = await client.callTool({
        name: 'write_note',
        arguments: { name: 'x.txt', content: 'y' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result.content)).toContain('MCP_TEST_DIR');
    } finally {
      await client.close();
    }
  });

  it('exits 1 on the first tool call with --crash-on-call', async () => {
    const result = await crashProbe();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--crash-on-call');
  });

  it('delays every call for --slow <ms>', async () => {
    const client = await connectServer(path.join(workspace, 'slow'), ['--slow', '300']);
    try {
      const started = Date.now();
      const echoed = await client.callTool({ name: 'echo', arguments: { text: 'later' } });
      expect(textOf(echoed.content)).toBe('later');
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    } finally {
      await client.close();
    }
  });
});

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'object' && part !== null && !Array.isArray(part)) {
        const record = part as Record<string, unknown>;
        return record['type'] === 'text' ? String(record['text'] ?? '') : '';
      }
      return '';
    })
    .join('');
}

async function connectServer(mcpTestDir: string, args: string[]): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, ...args],
    cwd: scenarioDir,
    env: envForChild({ MCP_TEST_DIR: mcpTestDir }),
    // Keep the server's diagnostics off the test output surface.
    stderr: 'pipe',
  });
  const client = new Client({ name: 'file-agent-scenario-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function runServer(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [serverPath, ...args], {
    cwd: scenarioDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return { code: await exitedWith(child, 15_000), stdout, stderr };
}

/**
 * One raw newline-delimited JSON-RPC tool call with `--crash-on-call`, so the
 * exit code is observed instead of inferred from a client error.
 */
async function crashProbe(): Promise<{ code: number; stderr: string }> {
  const child = spawn(process.execPath, [serverPath, '--crash-on-call'], {
    cwd: scenarioDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const frame = (value: unknown): string => `${JSON.stringify(value)}\n`;
  child.stdin.write(
    frame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'file-agent-crash-probe', version: '1.0.0' },
      },
    }),
  );
  child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  child.stdin.write(
    frame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'boom' } },
    }),
  );
  return { code: await exitedWith(child, 20_000), stderr };
}

function exitedWith(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP server did not exit within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (code === null) {
        reject(new Error(`MCP server was killed by ${signal ?? 'an unknown signal'}`));
        return;
      }
      resolve(code);
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
