import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { ConfigError } from '../errors/index.js';
import { rawConfigSchema, validateConfig, type RawConfig, type ResolvedConfig } from './schema.js';

export const CONFIG_FILE_NAMES = [
  'agent-shell.config.ts',
  'agent-shell.config.mts',
  'agent-shell.config.js',
] as const;

export interface DiscoverOptions {
  /** Value of `--config`, absolute or relative to cwd. */
  explicit?: string;
  cwd?: string;
  home?: string;
}

export function discoverConfigPath(options: DiscoverOptions = {}): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();

  if (options.explicit) {
    const resolved = path.resolve(cwd, options.explicit);
    if (!fs.existsSync(resolved)) {
      throw new ConfigError(`Config file not found: ${resolved}`);
    }
    return resolved;
  }

  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = path.join(home, '.agent-shell', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  filePath: string;
  /** Directory that owns the config file; workspaceRoot and relative dirs resolve from it. */
  baseDir: string;
}

function describeZodError(error: unknown): string {
  if (error instanceof Error && error.name === 'ZodError') {
    const issues = (
      error as unknown as { issues: Array<{ path: (string | number)[]; message: string }> }
    ).issues;
    return issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The config file is executable local code loaded through jiti (docs/01 §5.9);
 * it is trusted like a plugin, so validation is what bounds its shape.
 */
export async function loadConfig(filePath: string): Promise<LoadedConfig> {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw new ConfigError(`Config file not found: ${absolute}`);
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  let parsed: unknown;
  try {
    const mod = await jiti.import(absolute);
    parsed =
      mod && typeof mod === 'object' && 'default' in mod
        ? (mod as { default: unknown }).default
        : mod;
  } catch (error) {
    throw new ConfigError(`Failed to load config ${absolute}: ${describeZodError(error)}`, error);
  }
  return {
    config: finalizeConfig(parsed, absolute),
    filePath: absolute,
    baseDir: path.dirname(absolute),
  };
}

export function finalizeConfig(value: unknown, filePath: string): ResolvedConfig {
  try {
    const parsed = rawConfigSchema.parse(value as RawConfig);
    return validateConfig(parsed);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `Invalid configuration in ${filePath}: ${describeZodError(error)}`,
      error,
    );
  }
}

export interface RuntimePathOptions {
  workspaceFlag?: string;
  traceDirFlag?: string;
  cwd?: string;
  home?: string;
}

export interface RuntimePaths {
  workspaceRoot: string;
  dataDir: string;
  traceDir: string;
}

/** Precedence: CLI flag > environment > config file > default (docs/01 §5.9). */
export function resolveRuntimePaths(
  config: ResolvedConfig,
  baseDir: string,
  options: RuntimePathOptions = {},
): RuntimePaths {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = path.resolve(
    options.workspaceFlag ??
      process.env['AGENT_SHELL_WORKSPACE_ROOT'] ??
      config.workspaceRoot ??
      baseDir ??
      cwd,
  );
  const dataDir = path.resolve(
    options.traceDirFlag ??
      process.env['AGENT_SHELL_DATA_DIR'] ??
      (path.isAbsolute(config.trace.dataDir)
        ? config.trace.dataDir
        : path.resolve(baseDir ?? cwd, config.trace.dataDir)),
  );
  return { workspaceRoot, dataDir, traceDir: path.join(dataDir, 'traces') };
}

export function hasConfigFile(options: DiscoverOptions = {}): boolean {
  return discoverConfigPath(options) !== undefined;
}
