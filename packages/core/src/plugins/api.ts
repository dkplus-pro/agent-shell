import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../tools/types.js';

/**
 * Plugin API v1. Bumping this string is a breaking change for every plugin in
 * the wild: loaders must reject a manifest that does not match exactly.
 */
export const PLUGIN_API_VERSION = '1.0.0';

export const pluginManifestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/, 'manifest name must be lowercase kebab/snake'),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/, 'manifest version must be semver'),
    apiVersion: z.string().min(1),
    entry: z.string().min(1),
    description: z.string().default(''),
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export interface PluginContextTools {
  /** Register a tool; the loader namespaces it as `plugin__<name>__<tool>`. */
  add(tool: ToolDefinition<never, never>): void;
}

export interface PluginSetupContext {
  manifest: PluginManifest;
  workspaceRoot: string;
  pluginDir: string;
  allowOutsideWorkspace: boolean;
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  resolveWorkspacePath(input: string): string;
}

export interface Plugin {
  name: string;
  description: string;
  tools: Array<ToolDefinition<never, never>>;
}

export type PluginFactory = (ctx: PluginSetupContext) => Plugin | Promise<Plugin>;

export function definePlugin(factory: PluginFactory): PluginFactory {
  return factory;
}

export function definePluginTool<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  return tool;
}

export type { ToolContext, ToolDefinition };
