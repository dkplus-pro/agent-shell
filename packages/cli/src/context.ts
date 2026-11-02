/**
 * One function assembles the whole runtime from CLI flags (docs/01 §5.10: the
 * CLI holds no runtime logic; everything comes from @agent-shell/core).
 * Plugin registration, MCP connection, checkpointer and session store each sit
 * in exactly one function below so call-site changes stay local.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ConfigError,
  MCPAdapter,
  RunManager,
  SessionStore,
  ToolRegistry,
  collectEnvSecretValues,
  createProviderRegistry,
  discoverConfigPath,
  loadConfig,
  loadPlugins,
  makeEvent,
  newSpanId,
  openCheckpointer,
  redactValue,
  resolveRuntimePaths,
  traceFilePath,
  truncateText,
  type AgentEventSource,
  type AgentEventType,
  type ApprovalHandler,
  type McpServerConfig,
  type ModelScript,
  type NewEvent,
  type PluginLoadReport,
  type ResolvedConfig,
  type RunSummary,
  type ToolContext,
  type ToolOutput,
} from '@agent-shell/core';
import { assertSessionId, type GlobalFlags } from './flags.js';

export interface LoadedPluginInfo {
  name: string;
  version: string;
  apiVersion: string;
  tools: string[];
}

export interface FailedPluginInfo {
  name: string;
  path: string;
  message: string;
}

export interface McpServerInfo {
  name: string;
  transport: string;
  ok: boolean;
  toolCount: number;
  error?: string;
}

export interface CreateContextInput {
  flags: GlobalFlags;
  interactive: boolean;
  approvalHandler?: ApprovalHandler;
  /** Most commands need a config; `doctor` diagnoses without one. */
  requireConfig?: boolean;
}

export interface CliContext {
  config: ResolvedConfig;
  configPath: string | undefined;
  baseDir: string;
  workspaceRoot: string;
  dataDir: string;
  traceDir: string;
  providers: ReturnType<typeof createProviderRegistry>;
  registry: ToolRegistry;
  runManager: RunManager;
  plugins: { loaded: LoadedPluginInfo[]; failed: FailedPluginInfo[] };
  pluginReport: PluginLoadReport | undefined;
  mcp: { servers: McpServerInfo[]; errors: Array<{ server: string; message: string }> };
  sessions: SessionStore | undefined;
  /** Append startup events (plugin.loaded / mcp.*) to the first run's trace. */
  recordStartupEvents(summary: RunSummary): void;
  /** Persist session metadata for a finished run (state.sqlite only). */
  recordSession(summary: RunSummary, task: string): void;
  close(): Promise<void>;
}

export async function createContext(input: CreateContextInput): Promise<CliContext> {
  const { flags } = input;
  if (flags.session !== undefined) assertSessionId(flags.session);
  const configPath = discoverConfigPath({ explicit: flags.config });
  if (configPath === undefined) {
    if (input.requireConfig !== false) {
      throw new ConfigError(
        'No agent-shell.config.ts found. Create one in the current directory, place it at ~/.agent-shell/agent-shell.config.ts, or pass --config <path>.',
      );
    }
    return contextWithoutConfig(input);
  }

  const loaded = await loadConfig(configPath);
  const config = loaded.config;
  const paths = resolveRuntimePaths(config, loaded.baseDir, {
    workspaceFlag: flags.workspace,
    traceDirFlag: flags.traceDir,
  });

  // Script references in provider config are paths relative to the config file;
  // the CLI only materializes the text — parsing and validation stay in core.
  const providers = createProviderRegistry(config, {
    scriptResolver: (ref: string) => resolveModelScript(ref, loaded.baseDir),
  });

  const registry = new ToolRegistry();
  registry.registerCode(config.tools.code);

  const plugins = await loadPluginTools(
    config,
    registry,
    paths.workspaceRoot,
    flags.allowOutsideWorkspace,
  );
  const mcpHandle = await connectMcpServers(config, registry, paths.workspaceRoot);
  const state = await openCheckpointer({ kind: config.checkpointer, dataDir: paths.dataDir });
  const sessions = state.database !== undefined ? new SessionStore(state.database) : undefined;

  const runManager = new RunManager({
    config,
    dataDir: paths.dataDir,
    workspaceRoot: paths.workspaceRoot,
    providers,
    registry,
    interactive: input.interactive,
    yolo: flags.yolo,
    allowOutsideWorkspace: flags.allowOutsideWorkspace,
    checkpointer: state.saver,
    ...(input.approvalHandler === undefined ? {} : { approvalHandler: input.approvalHandler }),
  });

  const startupEvents = () => collectStartupEvents(plugins.report, mcpHandle);

  return {
    config,
    configPath,
    baseDir: loaded.baseDir,
    workspaceRoot: paths.workspaceRoot,
    dataDir: paths.dataDir,
    traceDir: paths.traceDir,
    providers,
    registry,
    runManager,
    plugins,
    pluginReport: plugins.report,
    mcp: mcpHandle,
    sessions,
    recordStartupEvents: makeStartupRecorder(paths.dataDir, startupEvents),
    recordSession: makeSessionRecorder(sessions),
    close: async () => {
      await mcpHandle.closeAdapter().catch(() => undefined);
      await state.close().catch(() => undefined);
      await providers.close().catch(() => undefined);
    },
  };
}

interface PluginLoadOutcome {
  loaded: LoadedPluginInfo[];
  failed: FailedPluginInfo[];
  report: PluginLoadReport | undefined;
}

/** A config with nothing in it: enough for `doctor` to explain what is missing. */
function emptyConfig(): ResolvedConfig {
  return {
    providers: {},
    defaults: { preset: 'single', agent: 'default' },
    tools: { code: [] },
    plugins: { enabled: true, dirs: [] },
    mcp: { servers: {} },
    agents: {},
    presets: {},
    approvals: { timeoutMs: 0, allowlist: [], extraHardDeny: [], nonInteractive: 'deny' },
    limits: {
      maxSteps: 40,
      tokenBudget: 200_000,
      maxWallTimeMs: 900_000,
      maxSubagents: 8,
      maxSubagentDepth: 2,
    },
    trace: {
      dataDir: '.agent-shell',
      streamDeltas: false,
      maxFieldBytes: 16_384,
      langsmith: 'off',
      redactEnvPrefixes: [],
    },
    checkpointer: 'memory',
  };
}

async function contextWithoutConfig(input: CreateContextInput): Promise<CliContext> {
  const cwd = process.cwd();
  const config = emptyConfig();
  const providers = createProviderRegistry(config, {});
  const registry = new ToolRegistry();
  const state = await openCheckpointer({ kind: 'memory', dataDir: cwd });
  const dataDir = path.resolve(input.flags.traceDir ?? path.join(cwd, '.agent-shell'));
  const runManager = new RunManager({
    config,
    dataDir,
    workspaceRoot: cwd,
    providers,
    registry,
    interactive: input.interactive,
    yolo: input.flags.yolo,
    allowOutsideWorkspace: input.flags.allowOutsideWorkspace,
    checkpointer: state.saver,
    ...(input.approvalHandler === undefined ? {} : { approvalHandler: input.approvalHandler }),
  });
  return {
    config,
    configPath: undefined,
    baseDir: cwd,
    workspaceRoot: cwd,
    dataDir,
    traceDir: path.join(dataDir, 'traces'),
    providers,
    registry,
    runManager,
    plugins: { loaded: [], failed: [] },
    pluginReport: undefined,
    mcp: { servers: [], errors: [] },
    sessions: undefined,
    recordStartupEvents: () => undefined,
    recordSession: () => undefined,
    close: async () => {
      await state.close().catch(() => undefined);
      await providers.close().catch(() => undefined);
    },
  };
}

function resolveModelScript(ref: string, baseDir: string): ModelScript {
  const trimmed = ref.trimStart();
  const source = trimmed.startsWith('{')
    ? trimmed
    : fs.readFileSync(path.resolve(baseDir, ref), 'utf8');
  return JSON.parse(source) as unknown as ModelScript;
}

// ---------------------------------------------------------------------------
// Plugins — single call site for core's loader; the registry namespaces each
// tool. Per-plugin failures never stop startup (report.failed surfaces them).
// ---------------------------------------------------------------------------

async function loadPluginTools(
  config: ResolvedConfig,
  registry: ToolRegistry,
  workspaceRoot: string,
  allowOutsideWorkspace: boolean,
): Promise<PluginLoadOutcome> {
  const report = await loadPlugins({
    dirs: config.plugins.dirs,
    workspaceRoot,
    enabled: config.plugins.enabled,
    allowOutsideWorkspace,
  });
  for (const entry of report.loaded) {
    registry.registerPlugin(entry.manifest.name, entry.tools);
  }
  const loaded: LoadedPluginInfo[] = report.loaded.map((entry) => ({
    name: entry.manifest.name,
    version: entry.manifest.version,
    apiVersion: entry.apiVersion,
    tools: registry
      .list({ source: 'plugin' })
      .filter((tool) => tool.pluginName === entry.manifest.name)
      .map((tool) => tool.name),
  }));
  const failed: FailedPluginInfo[] = report.failed.map((failure) => ({
    name: failure.name ?? path.basename(failure.dir),
    path: failure.path,
    message: failure.error.message,
  }));
  return { loaded, failed, report };
}

// ---------------------------------------------------------------------------
// MCP — connectAll comes from core's adapter (the CLI never builds upstream
// clients itself, AGENT.md §2). Failing servers are recorded, never fatal.
// ---------------------------------------------------------------------------

interface McpSetup {
  servers: McpServerInfo[];
  errors: Array<{ server: string; message: string }>;
  emissions: Array<{ type: AgentEventType; payload: Record<string, unknown> }>;
  closeAdapter(): Promise<void>;
}

async function connectMcpServers(
  config: ResolvedConfig,
  registry: ToolRegistry,
  workspaceRoot: string,
): Promise<McpSetup> {
  const emissions: McpSetup['emissions'] = [];
  const enabled = Object.entries(config.mcp.servers).filter(([, server]) => server.enabled);
  if (enabled.length === 0) {
    return { servers: [], errors: [], emissions, closeAdapter: async () => undefined };
  }
  const emit = (event: {
    type: 'mcp.connected' | 'mcp.disconnected' | 'mcp.error';
    payload: Record<string, unknown>;
  }): void => {
    emissions.push({ type: event.type, payload: event.payload });
  };

  let adapter: MCPAdapter;
  try {
    adapter = await MCPAdapter.connectAll({ servers: config.mcp.servers, workspaceRoot, emit });
  } catch (error) {
    return {
      servers: enabled.map(([name, server]) => ({
        name,
        transport: server.transport,
        ok: false,
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
      })),
      errors: enabled.map(([name]) => ({
        server: name,
        message: error instanceof Error ? error.message : String(error),
      })),
      emissions,
      closeAdapter: async () => undefined,
    };
  }

  const servers: McpServerInfo[] = adapter.status().map((status) => ({
    name: status.serverName,
    transport: status.transport,
    ok: status.connected,
    toolCount: status.toolCount,
    ...(status.lastError === undefined ? {} : { error: status.lastError.message }),
  }));
  const errors = servers
    .filter((server) => !server.ok && server.error !== undefined)
    .map((server) => ({ server: server.name, message: server.error ?? 'unknown error' }));

  const byServer = new Map<
    string,
    Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: { readOnlyHint?: boolean };
      call: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
    }>
  >();
  for (const descriptor of adapter.tools()) {
    const list = byServer.get(descriptor.serverName) ?? [];
    list.push({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      annotations: descriptor.annotations as { readOnlyHint?: boolean },
      call: (args: Record<string, unknown>, ctx: ToolContext) =>
        adapter.call(descriptor.finalName, args, { signal: ctx.signal }),
    });
    byServer.set(descriptor.serverName, list);
  }
  for (const [serverName, tools] of byServer) {
    const riskOverrides: Record<string, 'read' | 'write' | 'exec'> = riskOverridesFor(
      config.mcp.servers[serverName],
    );
    registry.registerMcp(serverName, tools, riskOverrides);
  }
  return { servers, errors, emissions, closeAdapter: () => adapter.close() };
}

function riskOverridesFor(
  server: McpServerConfig | undefined,
): Record<string, 'read' | 'write' | 'exec'> {
  return server === undefined ? {} : server.riskOverrides;
}

// ---------------------------------------------------------------------------
// Startup event recording — plugin/mcp events happen before any run exists;
// they are appended to the first run's trace so the JSONL stays the source of
// truth for the whole session (docs/03 §7: trace is the replay source).
// ---------------------------------------------------------------------------

function collectStartupEvents(
  pluginReport: PluginLoadReport | undefined,
  mcp: McpSetup,
): Array<{ type: AgentEventType; source: AgentEventSource; payload: Record<string, unknown> }> {
  const events: Array<{
    type: AgentEventType;
    source: AgentEventSource;
    payload: Record<string, unknown>;
  }> = [];
  for (const entry of pluginReport?.loaded ?? []) {
    events.push({
      type: 'plugin.loaded',
      source: 'plugin',
      payload: {
        name: entry.manifest.name,
        version: entry.manifest.version,
        apiVersion: entry.apiVersion,
        tools: entry.tools.map((tool) => tool.name),
      },
    });
  }
  for (const failure of pluginReport?.failed ?? []) {
    events.push({
      type: 'plugin.error',
      source: 'plugin',
      payload: {
        name: failure.name ?? path.basename(failure.dir),
        path: failure.path,
        error: failure.error,
      },
    });
  }
  for (const emission of mcp.emissions) {
    events.push({ type: emission.type, source: 'mcp', payload: emission.payload });
  }
  return events;
}

function makeStartupRecorder(
  dataDir: string,
  events: () => Array<{
    type: AgentEventType;
    source: AgentEventSource;
    payload: Record<string, unknown>;
  }>,
) {
  let recorded = false;
  return (summary: RunSummary): void => {
    if (recorded) return;
    recorded = true;
    const file = traceFilePath(dataDir, summary.sessionId, summary.runId);
    for (const event of events()) {
      const envelope: NewEvent<AgentEventType> = {
        type: event.type,
        source: event.source,
        sessionId: summary.sessionId,
        runId: summary.runId,
        spanId: newSpanId(),
        payload: event.payload,
      };
      fs.appendFileSync(file, `${JSON.stringify(makeEvent(envelope))}\n`);
    }
  };
}

function makeSessionRecorder(sessions: SessionStore | undefined) {
  return (summary: RunSummary, task: string): void => {
    if (sessions === undefined) return;
    const title = truncateText(task, 120).text.replace(/\s+/g, ' ').trim();
    sessions.create(summary.sessionId, { title });
    sessions.touch(summary.sessionId, {
      provider: summary.provider,
      model: summary.model,
      incrementRuns: true,
    });
  };
}

// ---------------------------------------------------------------------------
// Spawn tool: core's RunManager registers `runtime__spawn_subagent` per run
// with live budget state (packages/core/src/runtime/run-manager.ts), so the
// CLI registers nothing here — code tools only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config view for `/config` and config output — projected and serialized
// through core's redaction (docs/03 §9), so secret values cannot appear even
// if a future config embeds one by accident.
// ---------------------------------------------------------------------------

export function redactedConfigView(config: ResolvedConfig): string {
  const projection: Record<string, unknown> = {
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([id, provider]) => [
        id,
        {
          kind: provider.kind,
          models: provider.models,
          ...('apiKey' in provider && provider.apiKey !== undefined
            ? { apiKeyVariable: provider.apiKey.variable }
            : {}),
        },
      ]),
    ),
    defaults: config.defaults,
    workspaceRoot: config.workspaceRoot,
    tools: { code: config.tools.code.map((tool) => ({ name: tool.name, risk: tool.risk })) },
    plugins: config.plugins,
    mcp: { servers: Object.keys(config.mcp.servers) },
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([id, agent]) => [
        id,
        { name: agent.name, tools: agent.tools, provider: agent.provider, model: agent.model },
      ]),
    ),
    presets: config.presets,
    approvals: config.approvals,
    limits: config.limits,
    trace: config.trace,
    checkpointer: config.checkpointer,
  };
  const redacted = redactValue(projection, { secretValues: collectEnvSecretValues() });
  return JSON.stringify(redacted.value, null, 2);
}
