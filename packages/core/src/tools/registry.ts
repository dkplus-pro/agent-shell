import { z } from 'zod';
import { ConfigError, NameConflictError, UnknownToolError } from '../errors/index.js';
import { TOOL_RISKS, type Risk } from '../events/schema.js';
import {
  assertToolName,
  isReservedNamespace,
  mcpToolName,
  pluginToolName,
  runtimeToolName,
  splitToolName,
  type QualifiedOrigin,
} from './naming.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolOutput,
  type ToolSourceKind,
} from './types.js';

/**
 * Registration input is deliberately wider than `ToolDefinition`: `execute` is
 * contravariant in the argument type, so `ToolDefinition<never, never>` (what
 * `agent-shell.config.ts` and plugin manifests hand over) is not assignable to
 * `ToolDefinition<ToolJson, ToolOutput>`. Storing handlers that accept `never`
 * keeps every declaration usable without weakening the runtime contract.
 */
export interface RegistrableTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  risk?: Risk;
  timeoutMs?: number;
  idempotent?: boolean;
  execute: (args: never, ctx: ToolContext) => Promise<ToolOutput>;
}

/** One MCP `listTools()` entry plus the adapter's call closure. */
export interface McpToolInput {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  call: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

export interface RegisteredTool {
  name: string;
  description: string;
  source: ToolSourceKind;
  risk: Risk;
  schema: z.ZodTypeAny;
  execute: (args: never, ctx: ToolContext) => Promise<ToolOutput>;
  timeoutMs: number;
  idempotent: boolean;
  origin: QualifiedOrigin;
  pluginName?: string;
  serverName?: string;
}

export type RegisterCodeOptions = { reserve?: (name: string) => boolean };

export type RegisterFilter = { source?: ToolSourceKind };

export class ToolRegistry {
  readonly #entries = new Map<string, RegisteredTool>();
  readonly #missing: string[] = [];

  registerCode(tools: readonly RegistrableTool[], opts?: RegisterCodeOptions): void {
    for (const def of tools) {
      assertRegistrable(def, 'code tool');
      assertToolName(def.name);
      if (isReservedNamespace(def.name)) {
        const namespace = def.name.split('__')[0] ?? '';
        throw new ConfigError(
          `Code tool "${def.name}" uses the reserved namespace "${namespace}__". Only plugin, MCP and runtime tools may be namespaced.`,
        );
      }
      const risk = requireRisk(def, 'code tool');
      if (opts?.reserve?.(def.name)) {
        throw new NameConflictError(def.name, 'reserved', 'code');
      }
      this.#insert(def.name, def, 'code', risk, {});
    }
  }

  registerPlugin(pluginName: string, tools: readonly RegistrableTool[]): RegisteredTool[] {
    const added: RegisteredTool[] = [];
    for (const def of tools) {
      assertRegistrable(def, `plugin "${pluginName}" tool`);
      const risk = requireRisk(def, `plugin "${pluginName}" tool`);
      added.push(
        this.#insert(pluginToolName(pluginName, def.name), def, 'plugin', risk, { pluginName }),
      );
    }
    return added;
  }

  /**
   * MCP servers are external and untrusted, so their tools default to `exec`
   * and only an explicit `readOnlyHint` downgrades the risk (docs/01 §5.4).
   */
  registerMcp(
    serverName: string,
    tools: readonly McpToolInput[],
    riskOverrides: Record<string, Risk> = {},
  ): RegisteredTool[] {
    const added: RegisteredTool[] = [];
    for (const mcpTool of tools) {
      assertMcpTool(mcpTool, serverName);
      const override = Object.hasOwn(riskOverrides, mcpTool.name)
        ? riskOverrides[mcpTool.name]
        : undefined;
      const risk =
        override === undefined
          ? mcpTool.annotations?.readOnlyHint === true
            ? 'read'
            : 'exec'
          : readRisk(override, `MCP tool "${mcpTool.name}"`);
      const def: RegistrableTool = {
        name: mcpTool.name,
        description: mcpTool.description,
        schema: mcpArgsSchema(mcpTool.inputSchema),
        execute: (args, ctx) => mcpTool.call(toArgRecord(args), ctx),
      };
      added.push(
        this.#insert(mcpToolName(serverName, mcpTool.name), def, 'mcp', risk, { serverName }),
      );
    }
    return added;
  }

  registerRuntime(def: RegistrableTool): RegisteredTool {
    assertRegistrable(def, 'runtime tool');
    const risk = requireRisk(def, 'runtime tool');
    return this.#insert(runtimeToolName(def.name), def, 'runtime', risk, {});
  }

  get(name: string): RegisteredTool {
    const entry = this.#entries.get(name);
    if (entry === undefined) throw new UnknownToolError(name);
    return entry;
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  list(filter?: RegisterFilter): RegisteredTool[] {
    const all = [...this.#entries.values()];
    return filter?.source === undefined ? all : all.filter((tool) => tool.source === filter.source);
  }

  names(): string[] {
    return [...this.#entries.keys()];
  }

  size(): number {
    return this.#entries.size;
  }

  /**
   * Per-agent tool allowlist. Unknown names are skipped so a stale config entry
   * cannot break a run; they are reported through `missing` for diagnostics.
   */
  subset(names: readonly string[]): ToolRegistry {
    const next = new ToolRegistry();
    for (const name of names) {
      const entry = this.#entries.get(name);
      if (entry === undefined) {
        next.#missing.push(name);
        continue;
      }
      next.#entries.set(name, entry);
    }
    return next;
  }

  get missing(): string[] {
    return [...this.#missing];
  }

  #insert(
    name: string,
    def: RegistrableTool,
    source: ToolSourceKind,
    risk: Risk,
    owner: { pluginName?: string; serverName?: string },
  ): RegisteredTool {
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      throw new NameConflictError(name, existing.source, source);
    }
    const entry: RegisteredTool = {
      name,
      description: def.description,
      source,
      risk,
      schema: def.schema,
      execute: def.execute,
      timeoutMs: resolveTimeoutMs(def, name),
      idempotent: def.idempotent === true,
      origin: splitToolName(name),
      ...(owner.pluginName === undefined ? {} : { pluginName: owner.pluginName }),
      ...(owner.serverName === undefined ? {} : { serverName: owner.serverName }),
    };
    this.#entries.set(name, entry);
    return entry;
  }
}

function resolveTimeoutMs(def: RegistrableTool, name: string): number {
  if (def.timeoutMs === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  if (typeof def.timeoutMs !== 'number' || !Number.isFinite(def.timeoutMs) || def.timeoutMs <= 0) {
    throw new ConfigError(
      `Tool "${name}" has timeoutMs ${String(def.timeoutMs)}; it must be a positive number of milliseconds.`,
    );
  }
  return def.timeoutMs;
}

function requireRisk(def: RegistrableTool, context: string): Risk {
  if (def.risk === undefined) {
    throw new ConfigError(
      `${context} "${def.name}" must declare a risk level (${TOOL_RISKS.join(' | ')}).`,
    );
  }
  return readRisk(def.risk, `${context} "${def.name}"`);
}

function readRisk(value: unknown, tool: string): Risk {
  if (typeof value === 'string' && (TOOL_RISKS as readonly string[]).includes(value)) {
    return value as Risk;
  }
  throw new ConfigError(
    `${tool} declares risk ${String(value)}; expected one of ${TOOL_RISKS.join(', ')}.`,
  );
}

function assertRegistrable(def: RegistrableTool, context: string): void {
  if (typeof def.name !== 'string' || def.name.length === 0) {
    throw new ConfigError(`${context} must have a non-empty name.`);
  }
  if (typeof def.description !== 'string' || def.description.trim().length === 0) {
    throw new ConfigError(`${context} "${def.name}" must have a non-empty description.`);
  }
  if (typeof def.execute !== 'function') {
    throw new ConfigError(`${context} "${def.name}" must have an execute() handler.`);
  }
  if (
    !isRecord(def.schema) ||
    typeof (def.schema as { safeParse?: unknown }).safeParse !== 'function'
  ) {
    throw new ConfigError(`${context} "${def.name}" must have a zod schema.`);
  }
}

function assertMcpTool(tool: McpToolInput, serverName: string): void {
  const context = `MCP server "${serverName}" tool`;
  if (typeof tool.name !== 'string' || tool.name.length === 0) {
    throw new ConfigError(`${context} must report a non-empty name.`);
  }
  if (typeof tool.description !== 'string') {
    throw new ConfigError(`${context} "${tool.name}" must report a description.`);
  }
  if (!isRecord(tool.inputSchema)) {
    throw new ConfigError(`${context} "${tool.name}" must report an inputSchema object.`);
  }
  if (typeof tool.call !== 'function') {
    throw new ConfigError(`${context} "${tool.name}" must provide a call() function.`);
  }
}

function toArgRecord(value: never): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

const JSON_SCHEMA_PRIMITIVES = [
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
] as const;

/**
 * MCP describes arguments with JSON Schema while the executor validates with
 * zod, so a top-level conversion is required for the model to see any parameter
 * shape. Unsupported constructs collapse to `z.unknown()`: the server stays the
 * authority on its own arguments.
 */
function mcpArgsSchema(inputSchema: Record<string, unknown>): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties = isRecord(inputSchema['properties']) ? inputSchema['properties'] : {};
  const required = Array.isArray(inputSchema['required']) ? inputSchema['required'] : [];
  for (const [key, value] of Object.entries(properties)) {
    const field = jsonToZod(value);
    shape[key] = required.includes(key) ? field : field.optional();
  }
  return z.object(shape).loose() as unknown as z.ZodTypeAny;
}

function jsonToZod(node: unknown): z.ZodTypeAny {
  if (!isRecord(node)) return z.unknown();
  const enumValues = Array.isArray(node['enum']) ? node['enum'] : undefined;
  if (
    enumValues !== undefined &&
    enumValues.length > 0 &&
    enumValues.every((item) => typeof item === 'string')
  ) {
    return z.enum(enumValues as [string, ...string[]]);
  }
  const description = typeof node['description'] === 'string' ? node['description'] : undefined;
  const base = jsonTypeToZod(node['type'], node);
  return description === undefined ? base : base.describe(description);
}

function jsonTypeToZod(type: unknown, node: Record<string, unknown>): z.ZodTypeAny {
  if (typeof type === 'string' && (JSON_SCHEMA_PRIMITIVES as readonly string[]).includes(type)) {
    switch (type) {
      case 'string':
        return z.string();
      case 'number':
      case 'integer':
        return z.number();
      case 'boolean':
        return z.boolean();
      case 'null':
        return z.null();
      case 'array':
        return z.array(jsonToZod(node['items']));
      case 'object':
        return z.unknown();
    }
  }
  return z.unknown();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
