/**
 * Listing commands (`tools list`, `plugins list`, `mcp list|status`,
 * `providers list`, `sessions list|resume` support) and the row builders the
 * REPL reuses, so a table renders identically from both entry points.
 */
import { readdirSync } from 'node:fs';
import {
  type RegisteredTool,
  type ResolvedConfig,
  type SessionRecord,
  type ToolSourceKind,
} from '@agent-shell/core';
import { redactedConfigView, type CliContext } from '../context.js';
import { assertSessionId, type GlobalFlags } from '../flags.js';
import { formatTable } from '../render/renderer.js';
import type { ReplState } from '../repl/commands.js';

const TOOL_SOURCES: readonly ToolSourceKind[] = ['code', 'plugin', 'mcp', 'runtime'];

export function parseToolSource(value: string | undefined): ToolSourceKind | undefined {
  if (value === undefined) return undefined;
  const found = TOOL_SOURCES.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`Unknown tool source "${value}"; expected one of ${TOOL_SOURCES.join(', ')}.`);
  }
  return found;
}

export function toolsLines(
  registry: CliContext['registry'],
  source: ToolSourceKind | undefined,
): string[] {
  const filter = source === undefined ? undefined : { source };
  const tools = registry.list(filter).sort((a, b) => a.name.localeCompare(b.name));
  return formatTable(
    ['NAME', 'SOURCE', 'RISK', 'DESCRIPTION'],
    tools.map((tool: RegisteredTool) => [
      tool.name,
      tool.source,
      tool.risk,
      summarize(tool.description),
    ]),
  );
}

export function toolsJsonLines(
  registry: CliContext['registry'],
  source: ToolSourceKind | undefined,
): string[] {
  const filter = source === undefined ? undefined : { source };
  return registry
    .list(filter)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) =>
      JSON.stringify({
        name: tool.name,
        source: tool.source,
        risk: tool.risk,
        description: tool.description,
      }),
    );
}

export function pluginLines(ctx: CliContext): string[] {
  const rows = [
    ...ctx.plugins.loaded.map((plugin) => [
      plugin.name,
      plugin.version,
      plugin.apiVersion,
      String(plugin.tools.length),
      'loaded',
    ]),
    ...ctx.plugins.failed.map((plugin) => [
      plugin.name,
      '-',
      '-',
      '0',
      `failed: ${plugin.message}`,
    ]),
  ];
  if (rows.length === 0) return ['(no plugins configured)'];
  return formatTable(['NAME', 'VERSION', 'API', 'TOOLS', 'STATUS'], rows);
}

export function pluginsJsonLines(ctx: CliContext): string[] {
  return [
    ...ctx.plugins.loaded.map((plugin) => JSON.stringify({ ...plugin, status: 'loaded' })),
    ...ctx.plugins.failed.map((plugin) => JSON.stringify({ ...plugin, status: 'failed' })),
  ];
}

export function mcpLines(ctx: CliContext): string[] {
  if (ctx.mcp.servers.length === 0) return ['(no MCP servers configured)'];
  return formatTable(
    ['SERVER', 'TRANSPORT', 'STATUS', 'TOOLS'],
    ctx.mcp.servers.map((server) => [
      server.name,
      server.transport,
      server.ok ? 'connected' : `error: ${server.error ?? 'unknown'}`,
      String(server.toolCount),
    ]),
  );
}

export function mcpToolLines(ctx: CliContext): string[] {
  const tools = ctx.registry.list({ source: 'mcp' }).sort((a, b) => a.name.localeCompare(b.name));
  if (tools.length === 0) return ['(no MCP tools registered)'];
  return formatTable(
    ['TOOL', 'SERVER', 'RISK', 'DESCRIPTION'],
    tools.map((tool) => [
      tool.name,
      tool.serverName ?? '?',
      tool.risk,
      summarize(tool.description),
    ]),
  );
}

export function mcpJsonLines(ctx: CliContext): string[] {
  return [
    ...ctx.mcp.servers.map((server) => JSON.stringify({ kind: 'server', ...server })),
    ...ctx.registry
      .list({ source: 'mcp' })
      .map((tool) =>
        JSON.stringify({ kind: 'tool', name: tool.name, server: tool.serverName, risk: tool.risk }),
      ),
  ];
}

export function providerLines(ctx: CliContext): string[] {
  return formatTable(
    ['PROVIDER', 'KIND', 'MODELS', 'STREAM', 'TOOLS', 'VISION', 'CTX'],
    ctx.providers.list().map((provider) => {
      const models = provider.config.models;
      return [
        provider.id,
        provider.kind,
        models.length > 0 ? models.join(',') : '(default)',
        String(provider.capabilities.streaming),
        String(provider.capabilities.toolCalling),
        String(provider.capabilities.vision),
        String(provider.capabilities.contextWindow),
      ];
    }),
  );
}

export function providersJsonLines(ctx: CliContext): string[] {
  return ctx.providers.list().map((provider) =>
    JSON.stringify({
      id: provider.id,
      kind: provider.kind,
      models: provider.config.models,
      capabilities: provider.capabilities,
    }),
  );
}

/**
 * Sessions come from core's SessionStore when it has entries; otherwise the
 * trace directory is the ground truth (docs/03 §7: `trace list` scans the dir,
 * session ids are visible on disk without the database).
 */
export async function sessionsLines(ctx: CliContext): Promise<string[]> {
  const stored = await listStoredSessions(ctx);
  const rows = stored.map((record) => [
    record.id,
    summarize(record.title, 40),
    record.updatedAt.slice(0, 16).replace('T', ' '),
    String(record.messageCount ?? 0),
  ]);
  if (rows.length === 0) return ['(no sessions recorded)'];
  return formatTable(['SESSION', 'TITLE', 'UPDATED', 'MESSAGES'], rows);
}

export async function sessionsJsonLines(ctx: CliContext): Promise<string[]> {
  const stored = await listStoredSessions(ctx);
  if (stored.length > 0) return stored.map((record) => JSON.stringify(record));
  return traceSessionIds(ctx.traceDir).map((id) => JSON.stringify({ id, source: 'trace-dir' }));
}

async function listStoredSessions(ctx: CliContext): Promise<SessionRecord[]> {
  if (ctx.sessions === undefined) return traceSessionIds(ctx.traceDir).map(sessionFromDisk);
  const stored = ctx.sessions.list();
  if (stored.length > 0) return stored;
  return traceSessionIds(ctx.traceDir).map(sessionFromDisk);
}

function sessionFromDisk(id: string): SessionRecord {
  return {
    id,
    title: '(from trace directory)',
    createdAt: '',
    updatedAt: '',
  };
}

function traceSessionIds(traceDir: string): string[] {
  try {
    return readdirSync(traceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('ses_'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function traceLinesForState(ctx: CliContext, state: ReplState): string[] {
  const active = ctx.runManager.currentRun;
  if (active === undefined) {
    return state.turnCount === 0
      ? ['(no run in this session yet)']
      : [
          `session: ${state.sessionId ?? '(unknown)'} — last run finished; see agent-shell trace list`,
        ];
  }
  return [`run: ${active.runId}`, `trace: ${active.tracePath}`];
}

export function configViewLines(config: ResolvedConfig): string[] {
  return redactedConfigView(config).split('\n');
}

export function newSessionState(
  flags: GlobalFlags,
  explicit: string | undefined,
  resume: boolean,
): ReplState {
  const sessionId = explicit ?? undefined;
  if (sessionId !== undefined) assertSessionId(sessionId);
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    preset: flags.preset ?? 'single',
    resumed: resume && sessionId !== undefined,
    turnCount: 0,
    ...(flags.provider === undefined ? {} : { provider: flags.provider }),
  };
}

function summarize(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
