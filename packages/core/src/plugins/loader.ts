import fs from 'node:fs';
import path from 'node:path';
import { createJiti, type Jiti } from 'jiti';
import type { z } from 'zod';
import {
  NameConflictError,
  PluginApiVersionError,
  PluginError,
  toErrorPayload,
} from '../errors/index.js';
import { TOOL_RISKS, type Risk } from '../events/schema.js';
import { pluginToolName } from '../tools/naming.js';
import type { ToolDefinition } from '../tools/types.js';
import {
  PLUGIN_API_VERSION,
  pluginManifestSchema,
  type PluginFactory,
  type PluginManifest,
  type PluginSetupContext,
} from './api.js';

/**
 * Same-process plugin loader (docs/02-roadmap.md 阶段 3, AGENT.md §5).
 *
 * TRUST BOUNDARY: a plugin runs in-process with the shell's full privileges. This
 * loader isolates *failures* — one broken plugin never stops the others — but it
 * provides **no sandbox**: nothing here restricts what loaded code may do, and the
 * path guard does not bind plugin tools. Only explicitly enabled, user-trusted
 * directories may be passed to `loadPlugins`.
 *
 * Failure taxonomy used by the report and `plugin.error` events:
 * - declared-shape problems (manifest, apiVersion, entry location, missing risk)
 *   are `PLUGIN_INVALID` / `PLUGIN_API_VERSION` / `NAME_CONFLICT`;
 * - problems that only appear once the plugin's own code runs (import error,
 *   factory throw, non-Plugin return) are `PLUGIN_LOAD`.
 */

export const PLUGIN_MANIFEST_FILE = 'plugin.json';

export interface PluginLoadResult {
  manifest: PluginManifest;
  /** Absolute plugin directory, as resolved from the configured `dirs` entry. */
  dir: string;
  apiVersion: string;
  /** Raw (un-namespaced) tool definitions; the registry applies `pluginToolName`. */
  tools: ToolDefinition[];
}

export interface PluginLoadFailure {
  name?: string;
  dir: string;
  /** File the loader was reading when the plugin failed: manifest or entry. */
  path: string;
  error: { name: string; code?: string; message: string };
}

export interface PluginLoadReport {
  loaded: PluginLoadResult[];
  failed: PluginLoadFailure[];
}

export type PluginLoadedEventPayload = {
  name: string;
  version: string;
  apiVersion: string;
  tools: string[];
};

export type PluginErrorEventPayload = {
  name: string;
  path: string;
  error: { name: string; code?: string; message: string };
};

/** Exactly the keys `EVENT_PAYLOAD_SCHEMAS["plugin.loaded" | "plugin.error"]` allow. */
export type PluginEventPayload = PluginLoadedEventPayload | PluginErrorEventPayload;

export interface PluginLoadOptions {
  /** Directories scanned for `plugin.json`; relative entries resolve against cwd. */
  dirs?: string[];
  workspaceRoot: string;
  enabled: boolean;
  allowOutsideWorkspace?: boolean;
  emit?: (event: {
    type: 'plugin.loaded' | 'plugin.error';
    payload: Record<string, unknown>;
  }) => void;
  log?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  resolveWorkspacePath?: (input: string) => string;
}

type PluginOutcome =
  { ok: true; result: PluginLoadResult } | { ok: false; failure: PluginLoadFailure };

/**
 * Loads every enabled plugin directory. Never throws for a per-plugin problem:
 * those land in `report.failed` so a single bad plugin cannot stop shell startup.
 */
export async function loadPlugins(options: PluginLoadOptions): Promise<PluginLoadReport> {
  const report: PluginLoadReport = { loaded: [], failed: [] };
  const dirs = normalizeDirs(options.dirs);
  if (!options.enabled || dirs.length === 0) return report;

  const log = options.log ?? defaultLog;
  const emit = options.emit ?? defaultEmit;
  // One instance per scan. jiti v2 renamed the interop flag: `interopDefault` is
  // what exposes a `default` for CJS entries, and `moduleCache: false` means a
  // reload re-reads the file instead of handing back a stale module from an
  // earlier scan (docs/02-roadmap.md 阶段 3 risk note).
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });

  for (const dir of dirs) {
    const outcome = await loadOnePlugin(dir, jiti, options);
    if (outcome.ok) {
      report.loaded.push(outcome.result);
      emit({ type: 'plugin.loaded', payload: loadedPayload(outcome.result) });
      log('info', `plugin loaded: ${outcome.result.manifest.name}`, {
        dir: outcome.result.dir,
        toolCount: outcome.result.tools.length,
      });
      continue;
    }
    report.failed.push(outcome.failure);
    emit({ type: 'plugin.error', payload: failurePayload(outcome.failure) });
    log('error', `plugin failed: ${outcome.failure.name ?? 'unknown'}`, {
      dir: outcome.failure.dir,
      path: outcome.failure.path,
      code: outcome.failure.error.code,
      message: outcome.failure.error.message,
    });
  }
  return report;
}

function normalizeDirs(dirs: string[] | undefined): string[] {
  if (!Array.isArray(dirs)) return [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.trim().length === 0) continue;
    seen.add(path.resolve(dir));
  }
  return [...seen];
}

async function loadOnePlugin(
  dir: string,
  jiti: Jiti,
  options: PluginLoadOptions,
): Promise<PluginOutcome> {
  let name = path.basename(dir);
  let failurePath = path.join(dir, PLUGIN_MANIFEST_FILE);
  try {
    const manifest = readManifest(dir);
    name = manifest.name;

    const entryPath = path.resolve(dir, manifest.entry);
    failurePath = entryPath;
    assertEntryInsidePluginDir(manifest, dir, entryPath);
    assertEntryExists(manifest, entryPath);

    const factory = await importFactory(jiti, manifest, entryPath);
    const produced = await runFactory(factory, manifest, buildSetupContext(manifest, dir, options));
    const tools = validatePluginShape(produced, manifest);

    return {
      ok: true,
      result: { manifest, dir, apiVersion: manifest.apiVersion, tools },
    };
  } catch (error) {
    return {
      ok: false,
      failure: { name, dir, path: failurePath, error: errorPayloadFor(error) },
    };
  }
}

/**
 * `PluginApiVersionError` reports `code: "PLUGIN_INVALID"` because the frozen v1
 * error taxonomy only specialises `code` for its fields, so the dedicated
 * `PLUGIN_API_VERSION` code is re-applied here — CLI and trace readers key on it.
 */
function errorPayloadFor(error: unknown): { name: string; code?: string; message: string } {
  const payload = toErrorPayload(error);
  if (error instanceof PluginApiVersionError) payload.code = 'PLUGIN_API_VERSION';
  return payload;
}

function readManifest(dir: string): PluginManifest {
  if (!fs.existsSync(dir)) {
    throw new PluginError(
      `Plugin directory "${dir}" does not exist — fix the plugins.dirs entry or remove it.`,
    );
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw new PluginError(`Plugins.dirs entry "${dir}" is not a directory.`);
  }
  const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILE);
  if (!fs.existsSync(manifestPath)) {
    throw new PluginError(
      `Plugin directory "${dir}" has no ${PLUGIN_MANIFEST_FILE}; a manifest needs name, version, apiVersion, entry.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new PluginError(
      `${PLUGIN_MANIFEST_FILE} in "${dir}" is not valid JSON: ${messageOf(error)}`,
      error,
    );
  }

  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PluginError(
      `Invalid ${PLUGIN_MANIFEST_FILE} in "${dir}": ${describeIssues(parsed.error)}. Allowed keys are name, version, apiVersion, entry, description — unknown keys are rejected.`,
    );
  }
  if (parsed.data.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginApiVersionError(parsed.data.name, parsed.data.apiVersion, PLUGIN_API_VERSION);
  }
  return parsed.data;
}

/**
 * The entry is a path from a data file, so it must stay inside the plugin directory
 * that declared it: this rejects `..` segments, absolute paths and the directory
 * itself. It is a hygiene guard against a mistyped manifest — not a sandbox; plugin
 * code runs with the shell's own privileges either way (AGENT.md §5).
 */
function assertEntryInsidePluginDir(
  manifest: PluginManifest,
  dir: string,
  entryPath: string,
): void {
  const relative = path.relative(dir, entryPath);
  const escapes =
    relative.length === 0 ||
    relative === '.' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative);
  if (escapes) {
    throw new PluginError(
      `Plugin "${manifest.name}" entry "${manifest.entry}" resolves to "${entryPath}", outside its own directory "${dir}". Entries must stay inside the plugin directory.`,
    );
  }
}

function assertEntryExists(manifest: PluginManifest, entryPath: string): void {
  if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
    throw new PluginError(
      `Plugin "${manifest.name}" entry file not found: ${entryPath}`,
      undefined,
      true,
      {
        plugin: manifest.name,
        entry: entryPath,
      },
    );
  }
}

async function importFactory(
  jiti: Jiti,
  manifest: PluginManifest,
  entryPath: string,
): Promise<PluginFactory> {
  let moduleValue: unknown;
  try {
    moduleValue = await jiti.import(entryPath);
  } catch (error) {
    throw new PluginError(
      `Plugin "${manifest.name}" entry "${entryPath}" failed to load: ${messageOf(error)}`,
      error,
      false,
    );
  }
  const exported = defaultExportOf(moduleValue);
  if (!isPluginFactory(exported)) {
    throw new PluginError(
      `Plugin "${manifest.name}" entry must default-export a factory function, found ${typeName(exported)}.`,
      undefined,
      false,
    );
  }
  return exported;
}

async function runFactory(
  factory: PluginFactory,
  manifest: PluginManifest,
  ctx: PluginSetupContext,
): Promise<unknown> {
  try {
    // Awaited as `unknown` on purpose: the declared type is a compile-time promise,
    // and plugin code is validated at runtime before any of it is registered.
    const produced: unknown = await factory(ctx);
    return produced;
  } catch (error) {
    throw new PluginError(
      `Plugin "${manifest.name}" factory threw: ${messageOf(error)}`,
      error,
      false,
    );
  }
}

function buildSetupContext(
  manifest: PluginManifest,
  dir: string,
  options: PluginLoadOptions,
): PluginSetupContext {
  return {
    manifest,
    workspaceRoot: options.workspaceRoot,
    pluginDir: dir,
    log: options.log ?? defaultLog,
    allowOutsideWorkspace: options.allowOutsideWorkspace ?? false,
    resolveWorkspacePath: options.resolveWorkspacePath ?? ((input: string) => path.resolve(input)),
  };
}

function validatePluginShape(produced: unknown, manifest: PluginManifest): ToolDefinition[] {
  if (!isRecord(produced)) {
    throw new PluginError(
      `Plugin "${manifest.name}" factory returned ${typeName(produced)}, expected { name, description, tools }.`,
      undefined,
      false,
    );
  }
  if (!isNonEmptyString(produced['name'])) {
    throw new PluginError(
      `Plugin "${manifest.name}" must return a non-empty name string.`,
      undefined,
      false,
    );
  }
  if (typeof produced['description'] !== 'string') {
    throw new PluginError(
      `Plugin "${manifest.name}" must return a description string (got ${typeName(produced['description'])}).`,
      undefined,
      false,
    );
  }
  const tools = produced['tools'];
  if (!Array.isArray(tools)) {
    throw new PluginError(
      `Plugin "${manifest.name}" must return tools as an array (got ${typeName(tools)}).`,
      undefined,
      false,
    );
  }
  const seen = new Set<string>();
  return tools.map((entry) => validateTool(entry, manifest, seen));
}

function validateTool(entry: unknown, manifest: PluginManifest, seen: Set<string>): ToolDefinition {
  const label = `Plugin "${manifest.name}"`;
  if (!isRecord(entry)) {
    throw new PluginError(
      `${label} returned a tool that is not an object (${typeName(entry)}).`,
      undefined,
      false,
    );
  }
  const name = entry['name'];
  if (!isNonEmptyString(name)) {
    throw new PluginError(
      `${label} returned a tool without a non-empty name string.`,
      undefined,
      false,
    );
  }
  const toolLabel = `${label} tool "${name}"`;
  const description = entry['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new PluginError(`${toolLabel} must provide a non-empty description.`, undefined, false);
  }
  const risk = readRisk(entry['risk']);
  if (risk === undefined) {
    throw new PluginError(
      `${toolLabel} must declare risk as one of ${TOOL_RISKS.join(', ')}; risk is never defaulted because it drives approval.`,
    );
  }
  const schema = entry['schema'];
  if (!isToolSchema(schema)) {
    throw new PluginError(
      `${toolLabel} must provide a zod schema for its arguments.`,
      undefined,
      false,
    );
  }
  const execute = entry['execute'];
  if (!isToolExecute(execute)) {
    throw new PluginError(
      `${toolLabel} must provide an async execute() handler.`,
      undefined,
      false,
    );
  }

  const qualified = qualifiedToolName(manifest.name, name);
  if (seen.has(qualified)) {
    throw new NameConflictError(
      qualified,
      `plugin "${manifest.name}"`,
      `plugin "${manifest.name}"`,
    );
  }
  seen.add(qualified);

  const tool: ToolDefinition = { name, description, schema, risk, execute };
  const timeoutMs = entry['timeoutMs'];
  if (typeof timeoutMs === 'number') tool.timeoutMs = timeoutMs;
  const idempotent = entry['idempotent'];
  if (typeof idempotent === 'boolean') tool.idempotent = idempotent;
  return tool;
}

function qualifiedToolName(plugin: string, tool: string): string {
  try {
    return pluginToolName(plugin, tool);
  } catch (error) {
    throw new PluginError(
      `Plugin "${plugin}" tool "${tool}" cannot be namespaced as plugin__<plugin>__<tool>: ${messageOf(error)}`,
      error,
      false,
    );
  }
}

function loadedPayload(result: PluginLoadResult): PluginLoadedEventPayload {
  return {
    name: result.manifest.name,
    version: result.manifest.version,
    apiVersion: result.apiVersion,
    tools: result.tools.map((tool) => qualifiedToolName(result.manifest.name, tool.name)),
  };
}

function failurePayload(failure: PluginLoadFailure): PluginErrorEventPayload {
  return {
    name: failure.name ?? path.basename(failure.dir),
    path: failure.path,
    error: failure.error,
  };
}

function defaultExportOf(moduleValue: unknown): unknown {
  if (typeof moduleValue === 'function') return moduleValue;
  if (isRecord(moduleValue) && 'default' in moduleValue) return moduleValue['default'];
  return moduleValue;
}

function readRisk(value: unknown): Risk | undefined {
  return typeof value === 'string' && (TOOL_RISKS as readonly string[]).includes(value)
    ? (value as Risk)
    : undefined;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPluginFactory(value: unknown): value is PluginFactory {
  return typeof value === 'function';
}

function isToolSchema(value: unknown): value is ToolDefinition['schema'] {
  return isRecord(value) && typeof value['safeParse'] === 'function';
}

function isToolExecute(value: unknown): value is ToolDefinition['execute'] {
  return typeof value === 'function';
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Defaults are silence, not `console`: the CLI owns stdout/stderr and the loader
 * runs inside it (AGENT.md §3).
 */
function defaultLog(): void {
  return;
}

function defaultEmit(): void {
  return;
}
