import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRunId, newSessionId, newSpanId } from '../../src/ids.js';
import { PLUGIN_API_VERSION } from '../../src/plugins/api.js';
import { loadPlugins, type PluginLoadReport } from '../../src/plugins/loader.js';
import { makeEvent, validateEvent } from '../../src/events/schema.js';
import type { ToolContext } from '../../src/tools/types.js';

const FIXTURES = path.join(import.meta.dirname, '../fixtures/plugins');

type CapturedEvent = { type: 'plugin.loaded' | 'plugin.error'; payload: Record<string, unknown> };

/**
 * Every emitted payload is pushed through the frozen event schema, so a payload
 * that drifts from schema v1 (extra keys included) fails the test outright.
 */
async function load(
  dirs: string[] | undefined,
  overrides: { enabled?: boolean; workspaceRoot?: string } = {},
): Promise<{ report: PluginLoadReport; events: CapturedEvent[] }> {
  const events: CapturedEvent[] = [];
  const report = await loadPlugins({
    dirs,
    workspaceRoot: overrides.workspaceRoot ?? FIXTURES,
    enabled: overrides.enabled ?? true,
    emit: (event) => {
      events.push(event);
      validateEvent(
        makeEvent({
          type: event.type,
          sessionId: newSessionId(),
          runId: newRunId(),
          spanId: newSpanId(),
          source: 'plugin',
          payload: event.payload,
        }),
      );
    },
  });
  return { report, events };
}

function fixtureDir(name: string): string {
  return path.join(FIXTURES, name);
}

function toolContextStub(workspaceRoot: string): ToolContext {
  return {
    sessionId: newSessionId(),
    runId: newRunId(),
    spanId: newSpanId(),
    callId: 'call_test',
    toolName: 'plugin__word_count__count_words',
    signal: new AbortController().signal,
    workspaceRoot,
    allowOutsideWorkspace: false,
    log: () => {},
    resolveWorkspacePath: (input: string) => path.resolve(workspaceRoot, input),
  };
}

/**
 * Codes come from the frozen v1 taxonomy. `NameConflictError` keeps the class name
 * `ConfigError` (it passes that name to super), so the duplicate-tools fixture
 * reports `ConfigError`/`NAME_CONFLICT`; the discriminating signal is the code.
 */
const BROKEN: Array<{ dir: string; code: string; errorName: string }> = [
  { dir: 'invalid-manifest', code: 'PLUGIN_INVALID', errorName: 'PluginError' },
  { dir: 'api-version-mismatch', code: 'PLUGIN_API_VERSION', errorName: 'PluginApiVersionError' },
  { dir: 'traversal-entry', code: 'PLUGIN_INVALID', errorName: 'PluginError' },
  { dir: 'throwing-entry', code: 'PLUGIN_LOAD', errorName: 'PluginError' },
  { dir: 'duplicate-tools', code: 'NAME_CONFLICT', errorName: 'ConfigError' },
  { dir: 'missing-risk', code: 'PLUGIN_INVALID', errorName: 'PluginError' },
];

let scratch = '';

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shell-plugins-'));
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('loadPlugins — valid plugin', () => {
  it('loads word-count with its read tool and emits one schema-valid plugin.loaded', async () => {
    const { report, events } = await load([fixtureDir('word-count')]);

    expect(report.failed).toEqual([]);
    expect(report.loaded).toHaveLength(1);
    const result = report.loaded[0];
    expect(result?.manifest).toEqual({
      name: 'word-count',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      entry: 'entry.mjs',
      description: 'Counts the words in a block of text.',
    });
    expect(result?.dir).toBe(fixtureDir('word-count'));
    expect(result?.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(result?.tools).toHaveLength(1);
    const tool = result?.tools[0];
    expect(tool?.name).toBe('count_words');
    expect(tool?.risk).toBe('read');
    expect(tool?.idempotent).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('plugin.loaded');
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual([
      'apiVersion',
      'name',
      'tools',
      'version',
    ]);
    expect(events[0]?.payload).toEqual({
      name: 'word-count',
      version: '1.0.0',
      apiVersion: PLUGIN_API_VERSION,
      tools: ['plugin__word_count__count_words'],
    });
  });

  it('hands back a runnable tool definition', async () => {
    const { report } = await load([fixtureDir('word-count')]);
    const tool = report.loaded[0]?.tools[0];
    expect(tool).toBeDefined();
    const output = await tool?.execute(
      { text: 'same process full trust' },
      toolContextStub(FIXTURES),
    );
    expect(output).toEqual({ words: 4, characters: 23 });
  });

  it('passes the plugin setup context to the factory', async () => {
    const dir = path.join(scratch, 'context-probe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'context-probe',
        version: '2.0.0',
        apiVersion: PLUGIN_API_VERSION,
        entry: 'entry.mjs',
        description: 'Reports the context it was given.',
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      [
        'import { z } from "zod";',
        'export default function createPlugin(ctx) {',
        '  return {',
        '    name: ctx.manifest.name,',
        '    description: ctx.manifest.description,',
        '    tools: [{',
        '      name: "echo_context",',
        '      description: "Echoes the setup context.",',
        '      schema: z.object({}).strict(),',
        '      risk: "read",',
        '      idempotent: true,',
        '      async execute() {',
        '        return { pluginDir: ctx.pluginDir, workspaceRoot: ctx.workspaceRoot, allowOutside: ctx.allowOutsideWorkspace, resolved: ctx.resolveWorkspacePath("nested/file.txt") };',
        '      },',
        '    }],',
        '  };',
        '}',
      ].join('\n'),
    );

    const { report } = await load([dir], { workspaceRoot: '/tmp/workspace-root' });
    expect(report.failed).toEqual([]);
    const tool = report.loaded[0]?.tools[0];
    const output = await tool?.execute({}, toolContextStub('/tmp/workspace-root'));
    expect(output).toEqual({
      pluginDir: dir,
      workspaceRoot: '/tmp/workspace-root',
      allowOutside: false,
      resolved: path.resolve('nested/file.txt'),
    });
  });
});

describe('loadPlugins — controlled failures', () => {
  it.each(BROKEN)('one failed entry with code $code for $dir', async ({ dir, code, errorName }) => {
    const { report, events } = await load([fixtureDir(dir)]);

    expect(report.loaded).toEqual([]);
    expect(report.failed).toHaveLength(1);
    const failure = report.failed[0];
    expect(failure?.error.code).toBe(code);
    expect(failure?.error.name).toBe(errorName);
    expect(failure?.dir).toBe(fixtureDir(dir));
    expect(failure?.name).toBe(dir);
    expect(failure?.error.message.length).toBeGreaterThan(0);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('plugin.error');
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual(['error', 'name', 'path']);
    expect(Object.keys(failure?.error ?? {}).sort()).toEqual(['code', 'message', 'name']);
  });

  it('explains what was wrong, actionably', async () => {
    const messages = new Map<string, string>();
    for (const broken of BROKEN) {
      const { report } = await load([fixtureDir(broken.dir)]);
      messages.set(broken.dir, report.failed[0]?.error.message ?? '');
    }
    expect(messages.get('invalid-manifest')).toContain('version');
    expect(messages.get('invalid-manifest')).toContain('author');
    expect(messages.get('api-version-mismatch')).toContain('0.9.0');
    expect(messages.get('api-version-mismatch')).toContain(PLUGIN_API_VERSION);
    expect(messages.get('traversal-entry')).toContain('outside its own directory');
    expect(messages.get('throwing-entry')).toContain('boom from throwing-entry');
    expect(messages.get('duplicate-tools')).toContain('plugin__duplicate_tools__dupe');
    expect(messages.get('missing-risk')).toContain('no_risk');
    expect(messages.get('missing-risk')).toContain('read, write, exec');
  });

  it('keeps loading the healthy plugin while every broken one fails', async () => {
    const dirs = ['word-count', ...BROKEN.map((broken) => broken.dir)].map((name) =>
      fixtureDir(name),
    );
    const { report, events } = await load(dirs);

    expect(report.loaded.map((entry) => entry.manifest.name)).toEqual(['word-count']);
    expect(report.failed.map((failure) => failure.name).sort()).toEqual(
      BROKEN.map((broken) => broken.dir).sort(),
    );
    expect(events.filter((event) => event.type === 'plugin.loaded')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'plugin.error')).toHaveLength(BROKEN.length);
  });

  it('reports a missing or non-file plugin directory without throwing', async () => {
    const missing = path.join(scratch, 'does-not-exist');
    const noManifest = FIXTURES;
    const { report } = await load([missing, noManifest, fixtureDir('word-count')]);

    expect(report.loaded).toHaveLength(1);
    expect(report.failed).toHaveLength(2);
    expect(report.failed[0]?.error.code).toBe('PLUGIN_INVALID');
    expect(report.failed[0]?.error.message).toContain('does not exist');
    expect(report.failed[1]?.error.message).toContain('plugin.json');
  });

  it('rejects an entry that does not exist and a default export that is not a factory', async () => {
    const absentEntry = path.join(scratch, 'absent-entry');
    fs.mkdirSync(absentEntry, { recursive: true });
    fs.writeFileSync(
      path.join(absentEntry, 'plugin.json'),
      JSON.stringify({
        name: 'absent-entry',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        entry: 'nope.mjs',
        description: 'Points at a file that is not there.',
      }),
    );

    const notAFunction = path.join(scratch, 'not-a-function');
    fs.mkdirSync(notAFunction, { recursive: true });
    fs.writeFileSync(
      path.join(notAFunction, 'plugin.json'),
      JSON.stringify({
        name: 'not-a-function',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        entry: 'entry.mjs',
        description: 'Exports an object instead of a factory.',
      }),
    );
    fs.writeFileSync(
      path.join(notAFunction, 'entry.mjs'),
      "export default { not: 'a factory' };\n",
    );

    const { report } = await load([absentEntry, notAFunction]);
    expect(report.loaded).toEqual([]);
    expect(report.failed[0]?.error.code).toBe('PLUGIN_INVALID');
    expect(report.failed[0]?.error.message).toContain('not found');
    expect(report.failed[0]?.path).toBe(path.join(absentEntry, 'nope.mjs'));
    expect(report.failed[1]?.error.code).toBe('PLUGIN_LOAD');
    expect(report.failed[1]?.error.message).toContain('default-export a factory function');
  });

  it('treats an absolute entry and a factory return of the wrong shape as failures', async () => {
    const absoluteEntry = path.join(scratch, 'absolute-entry');
    fs.mkdirSync(absoluteEntry, { recursive: true });
    fs.writeFileSync(
      path.join(absoluteEntry, 'plugin.json'),
      JSON.stringify({
        name: 'absolute-entry',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        entry: path.join(scratch, 'elsewhere.mjs'),
        description: 'Declares an absolute entry outside the plugin dir.',
      }),
    );

    const badReturn = path.join(scratch, 'bad-return');
    fs.mkdirSync(badReturn, { recursive: true });
    fs.writeFileSync(
      path.join(badReturn, 'plugin.json'),
      JSON.stringify({
        name: 'bad-return',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        entry: 'entry.mjs',
        description: 'The factory returns a string.',
      }),
    );
    fs.writeFileSync(path.join(badReturn, 'entry.mjs'), "export default () => 'nope';\n");

    const { report } = await load([absoluteEntry, badReturn]);
    expect(report.loaded).toEqual([]);
    expect(report.failed[0]?.error.code).toBe('PLUGIN_INVALID');
    expect(report.failed[0]?.error.message).toContain('outside its own directory');
    expect(report.failed[1]?.error.code).toBe('PLUGIN_LOAD');
    expect(report.failed[1]?.error.message).toContain('expected { name, description, tools }');
  });
});

describe('loadPlugins — disabled and empty input', () => {
  it('starts clean when plugins are disabled', async () => {
    const { report, events } = await load([fixtureDir('word-count')], { enabled: false });
    expect(report).toEqual({ loaded: [], failed: [] });
    expect(events).toEqual([]);
  });

  it('starts clean for empty, missing or blank dirs', async () => {
    for (const dirs of [[], undefined, ['   ']]) {
      const { report, events } = await load(dirs);
      expect(report).toEqual({ loaded: [], failed: [] });
      expect(events).toEqual([]);
    }
  });

  it('survives a plugin whose namespaced tool name breaks the naming rules', async () => {
    const dir = path.join(scratch, 'oversized-tool-name');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'plugin.json'),
      JSON.stringify({
        name: 'oversized-tool-name',
        version: '1.0.0',
        apiVersion: PLUGIN_API_VERSION,
        entry: 'entry.mjs',
        description: 'Uses a tool name too long to namespace.',
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'entry.mjs'),
      [
        'import { z } from "zod";',
        'export default function createPlugin(ctx) {',
        '  return {',
        '    name: ctx.manifest.name,',
        '    description: ctx.manifest.description,',
        "    tools: [{ name: 'count_" +
          'w'.repeat(70) +
          "', description: 'Too long to namespace.', schema: z.object({}).strict(), risk: 'read', async execute() { return 1; } }],",
        '  };',
        '}',
      ].join('\n'),
    );

    const { report, events } = await load([dir, fixtureDir('word-count')]);
    expect(report.loaded).toHaveLength(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.error.code).toBe('PLUGIN_LOAD');
    expect(report.failed[0]?.error.message).toContain('cannot be namespaced');
    expect(events).toHaveLength(2);
  });
});
