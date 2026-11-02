import { ConfigError } from '../errors/index.js';

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const NAME_NAMESPACES = {
  plugin: 'plugin',
  mcp: 'mcp',
  runtime: 'runtime',
} as const;

/** Namespace separators are double underscores so a single underscore in a server name cannot fake a namespace. */
const SEP = '__';

export function normalizeNameSegment(raw: string): string {
  const lowered = raw.normalize('NFKC').toLowerCase().trim();
  const collapsed = lowered
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  if (collapsed.length === 0) return 'unnamed';
  return /^[a-z]/.test(collapsed) ? collapsed : `t_${collapsed}`;
}

export function assertToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Invalid tool name "${name}": names must match ${TOOL_NAME_PATTERN.source} (lowercase ascii, starting with a letter).`,
    );
  }
}

export function pluginToolName(plugin: string, tool: string): string {
  return qualified(
    NAME_NAMESPACES.plugin,
    normalizeNameSegment(plugin),
    normalizeNameSegment(tool),
  );
}

export function mcpToolName(server: string, tool: string): string {
  return qualified(NAME_NAMESPACES.mcp, normalizeNameSegment(server), normalizeNameSegment(tool));
}

export function runtimeToolName(tool: string): string {
  return qualified(NAME_NAMESPACES.runtime, normalizeNameSegment(tool));
}

function qualified(namespace: string, ...parts: string[]): string {
  const name = [namespace, ...parts].join(SEP);
  assertToolName(name);
  if (name.length > 64) {
    throw new ConfigError(`Tool name "${name}" exceeds the 64 character limit.`);
  }
  return name;
}

export type QualifiedOrigin =
  | { kind: 'code' }
  | { kind: 'plugin'; plugin: string; tool: string }
  | { kind: 'mcp'; server: string; tool: string }
  | { kind: 'runtime'; tool: string };

export function splitToolName(name: string): QualifiedOrigin {
  const [head, first, second] = name.split(SEP);
  if (head === NAME_NAMESPACES.plugin && first !== undefined && second !== undefined) {
    return { kind: 'plugin', plugin: first, tool: second };
  }
  if (head === NAME_NAMESPACES.mcp && first !== undefined && second !== undefined) {
    return { kind: 'mcp', server: first, tool: second };
  }
  if (head === NAME_NAMESPACES.runtime && first !== undefined) {
    return { kind: 'runtime', tool: first };
  }
  return { kind: 'code' };
}

export function isReservedNamespace(name: string): boolean {
  const head = name.split(SEP)[0];
  return (
    head === NAME_NAMESPACES.plugin ||
    head === NAME_NAMESPACES.mcp ||
    head === NAME_NAMESPACES.runtime
  );
}
