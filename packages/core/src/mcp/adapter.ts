/**
 * MCP client adapter (docs/01-architecture.md §5.4, docs/02-roadmap.md 阶段 4).
 *
 * This is the ONLY module in the repository allowed to import `@langchain/mcp-adapters`
 * (AGENT.md §2): every upstream type is converted here into agent-shell contracts, so an
 * MCP API change touches one file instead of leaking into the runtime.
 *
 * Trust model (AGENT.md §5): an MCP server is external and untrusted. Tool risk is
 * therefore `exec` unless the operator overrides it or the server declares the
 * `readOnlyHint` annotation, and a call result is returned as data — never interpreted as
 * instructions, never auto-approved.
 */
import path from 'node:path';
import process from 'node:process';
import {
  MCPAdapter as UpstreamMCPAdapter,
  type HTTPConnection,
  type StdioConnection,
} from '@langchain/mcp-adapters';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { revealSecret } from '../config/secret.js';
import type { McpServerConfig } from '../config/schema.js';
import { McpError, toErrorPayload } from '../errors/index.js';
import type { Risk } from '../events/schema.js';
import { mcpToolName } from '../tools/naming.js';
import type { ToolOutput } from '../tools/types.js';

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** Teardown guard: a wedged handshake must never block shutdown. */
const CLOSE_GRACE_MS = 5_000;

/**
 * Upstream backstop only: `call()` enforces the configured deadline itself and aborts the
 * request, so the SDK timer must sit strictly behind ours or it would win the race and be
 * reported as a server failure instead of a timeout.
 */
const UPSTREAM_TIMEOUT_BACKSTOP_MS = 5_000;

/** Event names this adapter emits; payloads are checked by event schema v1. */
export type McpEventName = 'mcp.connected' | 'mcp.disconnected' | 'mcp.error';

export interface McpEmission {
  type: McpEventName;
  payload: Record<string, unknown>;
}

export type McpEmit = (event: McpEmission) => void;

export interface McpToolDescriptor {
  serverName: string;
  /** Namespaced, registry-facing name: `mcp__<server>__<tool>`. */
  finalName: string;
  /** Raw tool name exactly as the server reports it. */
  name: string;
  description: string;
  /** JSON Schema, handed to the model as the tool declaration. */
  inputSchema: Record<string, unknown>;
  risk: Risk;
  /** MCP annotations, verbatim: hints only, never authorization. */
  annotations: Record<string, unknown>;
}

export interface McpErrorPayload {
  name: string;
  code?: string;
  message: string;
}

export interface McpServerStatus {
  serverName: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  toolCount: number;
  lastError?: McpErrorPayload;
}

/** Name used by the package public surface (`src/index.ts`) for a per-server status. */
export type McpServerHandle = McpServerStatus;

export interface McpCallOptions {
  signal?: AbortSignal;
}

interface ToolBinding {
  descriptor: McpToolDescriptor;
  tool: DynamicStructuredTool;
  timeoutMs: number;
}

interface ServerState {
  serverName: string;
  transport: 'stdio' | 'http';
  timeoutMs: number;
  upstream: UpstreamMCPAdapter | undefined;
  connected: boolean;
  closed: boolean;
  /** Per-server tools, keyed by namespaced `finalName`. */
  tools: Map<string, ToolBinding>;
  lastError: McpErrorPayload | undefined;
}

/**
 * A crashed server reports a transport-level death; other failures (bad arguments,
 * JSON-RPC error) leave the connection alive and must not be shown as disconnected.
 */
const TRANSPORT_DEATH =
  /connection closed|not connected|transport closed|process exited|socket hang up/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorPayload(error: unknown): McpErrorPayload {
  return toErrorPayload(error) as McpErrorPayload;
}

/** Forwards only the variable NAMES listed in config; values are read from process.env. */
function childEnvironment(
  names: readonly string[] | undefined,
): Record<string, string> | undefined {
  if (names === undefined || names.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function resolveCommand(command: string, workspaceRoot: string): string {
  return command.includes('/') || command.includes(path.sep)
    ? path.resolve(workspaceRoot, command)
    : command;
}

/** Upstream connection object for one configured server. */
function upstreamConnection(
  config: McpServerConfig,
  workspaceRoot: string,
  timeoutMs: number,
): StdioConnection | HTTPConnection {
  if (config.transport === 'stdio') {
    const env = childEnvironment(config.envVars);
    return {
      transport: 'stdio',
      mode: 'auto',
      command: resolveCommand(config.command, workspaceRoot),
      args: [...(config.args ?? [])],
      cwd: config.cwd === undefined ? workspaceRoot : path.resolve(workspaceRoot, config.cwd),
      ...(env === undefined ? {} : { env }),
      /** Child stderr is not part of the trace, and an undrained pipe can wedge a child. */
      stderr: 'ignore',
      defaultToolTimeout: timeoutMs + UPSTREAM_TIMEOUT_BACKSTOP_MS,
    };
  }
  const headers: Record<string, string> = {};
  for (const [name, ref] of Object.entries(config.headers ?? {})) {
    const value = revealSecret(ref);
    if (value !== undefined) headers[name] = value;
  }
  return {
    transport: 'http',
    mode: 'auto',
    url: config.url,
    headers,
    defaultToolTimeout: timeoutMs + UPSTREAM_TIMEOUT_BACKSTOP_MS,
  };
}

/** `listToolsets()` keeps the per-server grouping, which is what namespacing needs. */
function annotationsOf(tool: DynamicStructuredTool): Record<string, unknown> {
  const metadata = (tool as unknown as { metadata?: unknown }).metadata;
  if (!isRecord(metadata)) return {};
  const annotations = metadata.annotations;
  return isRecord(annotations) ? annotations : {};
}

/** `riskOverrides` win over annotations; only an explicit read-only hint may downgrade. */
function riskFor(
  overrides: Record<string, Risk> | undefined,
  name: string,
  annotations: Record<string, unknown>,
): Risk {
  const override = overrides?.[name];
  if (override === 'read' || override === 'write' || override === 'exec') return override;
  return annotations.readOnlyHint === true ? 'read' : 'exec';
}

/** The upstream adapter hands the server's JSON Schema back on `tool.schema`. */
function jsonSchemaOf(tool: DynamicStructuredTool): Record<string, unknown> {
  const schema = (tool as unknown as { schema?: unknown }).schema;
  if (isRecord(schema)) {
    const looksLikeZod = typeof schema.safeParse === 'function' || '_zod' in schema;
    if (!looksLikeZod) return schema;
    try {
      return z.toJSONSchema(schema as unknown as z.ZodType) as Record<string, unknown>;
    } catch {
      /* an unusable schema fails at call time rather than being guessed here */
    }
  }
  return { type: 'object', properties: {} };
}

function textOfBlock(block: Record<string, unknown>): string | undefined {
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function jsonSafeRecord(record: Record<string, unknown>): { [key: string]: ToolOutput } {
  const out: { [key: string]: ToolOutput } = {};
  for (const [key, value] of Object.entries(record)) out[key] = jsonSafe(value);
  return out;
}

/** Tool output is data: normalize to JSON-safe values, joining text and JSON-encoding blocks. */
function jsonSafe(value: unknown): ToolOutput {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const contentLike = value.every((item) => typeof item === 'string' || isRecord(item));
    if (contentLike) {
      return value
        .map((item) =>
          typeof item === 'string'
            ? item
            : (textOfBlock(item) ?? JSON.stringify(jsonSafeRecord(item))),
        )
        .join('\n');
    }
    return value.map((item) => jsonSafe(item));
  }
  if (isRecord(value)) return jsonSafeRecord(value);
  return String(value);
}

/** One-line, bounded message so a raw JSON-RPC dump never reaches a trace verbatim. */
function normalizeMessage(error: unknown): string {
  const message = errorPayload(error).message.replace(/\s+/g, ' ').trim();
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

/**
 * Races `work` against a deadline, clearing the timer on the way out and running
 * `onTimeout` (aborting the upstream request) before the rejection is observed.
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  makeError: () => McpError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      onTimeout();
      reject(makeError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Connected MCP servers plus their tool catalogue. Built with {@link MCPAdapter.connectAll};
 * one instance owns exactly one upstream connection per enabled server, so a crash inside
 * one server cannot take the others with it.
 */
export class MCPAdapter {
  private readonly servers = new Map<string, ServerState>();
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly emit: McpEmit;
  private closed = false;

  private constructor(emit: McpEmit) {
    this.emit = emit;
  }

  /**
   * Connects every enabled server and lists its tools. A server that cannot be reached is
   * isolated: `mcp.error` is emitted, its status stays empty, and the other servers keep
   * working. Disabled servers are skipped entirely — no connection, no event. A namespaced
   * name claimed by two servers aborts the whole connect, because silently dropping one
   * would route a tool call to the wrong server.
   */
  static async connectAll(options: {
    servers: Record<string, McpServerConfig>;
    workspaceRoot: string;
    emit: McpEmit;
    defaultTimeoutMs?: number;
  }): Promise<MCPAdapter> {
    const { servers, workspaceRoot, emit, defaultTimeoutMs = DEFAULT_MCP_TIMEOUT_MS } = options;
    const adapter = new MCPAdapter(emit);
    for (const [serverName, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      await adapter.connectServer(serverName, config, workspaceRoot, defaultTimeoutMs);
    }
    return adapter;
  }

  /** Catalogue of every connected tool, keyed by its namespaced `finalName`. */
  tools(): McpToolDescriptor[] {
    return [...this.bindings.values()].map((binding) => binding.descriptor);
  }

  get(finalName: string): McpToolDescriptor | undefined {
    return this.bindings.get(finalName)?.descriptor;
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((state) => ({
      serverName: state.serverName,
      transport: state.transport,
      connected: state.connected && !state.closed,
      toolCount: state.tools.size,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    }));
  }

  /**
   * Calls one tool under its server's `timeoutMs`. Every failure arrives as an `McpError`
   * (`MCP_TIMEOUT` for our deadline, `MCP_CALL` for a server, JSON-RPC or transport
   * failure) and leaves the adapter usable; the result is normalized JSON-safe data.
   */
  async call(
    finalName: string,
    args: Record<string, unknown>,
    ctx?: McpCallOptions,
  ): Promise<ToolOutput> {
    const binding = this.bindings.get(finalName);
    if (binding === undefined) {
      throw new McpError(`Unknown MCP tool "${finalName}"`, undefined, 'MCP_CALL');
    }
    const state = this.servers.get(binding.descriptor.serverName);
    if (state === undefined || state.closed || state.upstream === undefined) {
      throw new McpError(
        `MCP server "${binding.descriptor.serverName}" is closed; cannot call "${finalName}"`,
        undefined,
        'MCP_CALL',
      );
    }
    const server = binding.descriptor.serverName;
    const started = Date.now();

    /** Our own controller: aborted by the caller's signal or by the deadline. */
    const controller = new AbortController();
    const outer = ctx?.signal;
    const forwardAbort = (): void => controller.abort(outer?.reason);
    if (outer?.aborted === true) forwardAbort();
    else outer?.addEventListener('abort', forwardAbort, { once: true });

    // The upstream adapter forwards `config.signal` into the JSON-RPC request, so an
    // aborted call releases the connection instead of leaking a pending request.
    const invocation = binding.tool.invoke({ ...args }, { signal: controller.signal });
    /**
     * Aborting the request can reject `invocation` in the same tick as our deadline, so
     * the observed error is not always ours: the flag, not the message, decides MCP_TIMEOUT.
     */
    let timedOut = false;
    const timeoutMessage = `MCP tool "${finalName}" on server "${server}" timed out after ${binding.timeoutMs}ms`;
    try {
      const raw = await withTimeout(
        invocation,
        binding.timeoutMs,
        () => {
          timedOut = true;
          controller.abort();
        },
        () => new McpError(timeoutMessage, undefined, 'MCP_TIMEOUT'),
      );
      return jsonSafe(raw);
    } catch (error) {
      if (timedOut) {
        const cause = error instanceof McpError ? undefined : error;
        const timed = new McpError(timeoutMessage, cause, 'MCP_TIMEOUT');
        state.lastError = errorPayload(timed);
        throw timed;
      }
      const detail = normalizeMessage(error);
      const mapped =
        error instanceof McpError
          ? error
          : new McpError(
              `MCP tool "${finalName}" on server "${server}" failed after ${Date.now() - started}ms: ${detail}`,
              error,
              'MCP_CALL',
            );
      /** A dead transport is reported by `status()`; the adapter itself stays usable. */
      if (!(error instanceof McpError) && TRANSPORT_DEATH.test(detail)) state.connected = false;
      state.lastError = errorPayload(mapped);
      throw mapped;
    } finally {
      outer?.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * Closes every connection and emits one `mcp.disconnected` per server. Idempotent, and a
   * server whose process is already gone cannot make this reject.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.servers.values()) {
      const wasConnected = state.connected;
      const hadTools = state.tools.size > 0;
      state.connected = false;
      state.closed = true;
      for (const name of state.tools.keys()) this.bindings.delete(name);
      state.tools.clear();
      await this.releaseUpstream(state);
      if (wasConnected || hadTools) {
        this.emit({
          type: 'mcp.disconnected',
          payload: { server: state.serverName, reason: 'closed' },
        });
      }
    }
  }

  /** Connects one server; a failure is recorded and emitted, never rethrown. */
  private async connectServer(
    serverName: string,
    config: McpServerConfig,
    workspaceRoot: string,
    defaultTimeoutMs: number,
  ): Promise<void> {
    const timeoutMs = config.timeoutMs ?? defaultTimeoutMs;
    const state: ServerState = {
      serverName,
      transport: config.transport,
      timeoutMs,
      upstream: undefined,
      connected: false,
      closed: false,
      tools: new Map(),
      lastError: undefined,
    };
    this.servers.set(serverName, state);

    let listed: DynamicStructuredTool[];
    try {
      const upstream = new UpstreamMCPAdapter({
        servers: { [serverName]: upstreamConnection(config, workspaceRoot, timeoutMs) },
        /** Namespacing is agent-shell's job (`mcp__server__tool`), never the SDK's. */
        prefixToolNameWithServerName: false,
        onConnectionError: 'throw',
        throwOnLoadError: true,
      });
      state.upstream = upstream;
      /**
       * Discovery includes spawning the child, so it gets the documented 30s connect
       * budget (docs/01-architecture.md §7) even when calls are configured stricter;
       * otherwise a short `timeoutMs` would fail every stdio handshake.
       */
      const discoveryMs = Math.max(timeoutMs, DEFAULT_MCP_TIMEOUT_MS);
      listed = await withTimeout(
        upstream.listToolsets().then((toolsets) => toolsets[serverName] ?? []),
        discoveryMs,
        () => undefined,
        () =>
          new McpError(
            `MCP server "${serverName}" did not answer tools/list within ${discoveryMs}ms`,
            undefined,
            'MCP_CONNECT',
          ),
      );
    } catch (error) {
      state.lastError = errorPayload(error);
      await this.releaseUpstream(state);
      this.emit({ type: 'mcp.error', payload: { server: serverName, error: state.lastError } });
      return;
    }

    try {
      this.indexTools(state, listed, config.riskOverrides as Record<string, Risk> | undefined);
    } catch (error) {
      for (const name of state.tools.keys()) this.bindings.delete(name);
      state.tools.clear();
      state.lastError = errorPayload(error);
      await this.releaseUpstream(state);
      throw error;
    }

    state.connected = true;
    this.emit({
      type: 'mcp.connected',
      payload: { server: serverName, transport: state.transport, toolCount: state.tools.size },
    });
  }

  /** Builds descriptors and claims namespaced names; a collision aborts the connect. */
  private indexTools(
    state: ServerState,
    listed: readonly DynamicStructuredTool[],
    overrides: Record<string, Risk> | undefined,
  ): void {
    for (const tool of listed) {
      const name = tool.name;
      const annotations = annotationsOf(tool);
      const descriptor: McpToolDescriptor = {
        serverName: state.serverName,
        finalName: mcpToolName(state.serverName, name),
        name,
        description: tool.description ?? '',
        inputSchema: jsonSchemaOf(tool),
        risk: riskFor(overrides, name, annotations),
        annotations,
      };
      const taken = this.bindings.get(descriptor.finalName)?.descriptor;
      if (taken !== undefined) {
        throw new McpError(
          `MCP tool name collision: "${descriptor.finalName}" is exposed by server ` +
            `"${taken.serverName}" (tool "${taken.name}") and by server "${state.serverName}" ` +
            `(tool "${name}"). Rename one of them or disable one server.`,
          undefined,
          'MCP_CONNECT',
        );
      }
      const binding: ToolBinding = { descriptor, tool, timeoutMs: state.timeoutMs };
      /** Keyed by `finalName`, exactly like the adapter-wide index. */
      state.tools.set(descriptor.finalName, binding);
      this.bindings.set(descriptor.finalName, binding);
    }
  }

  /** Tears one upstream connection down; a dead child can neither reject nor hang us. */
  private async releaseUpstream(state: ServerState): Promise<void> {
    const upstream = state.upstream;
    state.upstream = undefined;
    if (upstream === undefined) return;
    try {
      await withTimeout(
        upstream.close(),
        CLOSE_GRACE_MS,
        () => undefined,
        () =>
          new McpError(
            `MCP server "${state.serverName}" did not close within ${CLOSE_GRACE_MS}ms`,
            undefined,
            'MCP_CONNECT',
          ),
      );
    } catch {
      /** Closing a server that already crashed is best effort by design. */
    }
  }
}
