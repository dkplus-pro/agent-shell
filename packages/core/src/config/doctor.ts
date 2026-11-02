import fs from 'node:fs';
import path from 'node:path';
import { revealSecret } from '../config/secret.js';
import type { ResolvedConfig } from '../config/schema.js';
import type { PluginLoadReport } from '../plugins/loader.js';

export type DoctorStatus = 'ok' | 'warn' | 'error';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  version: string;
}

export interface DoctorInput {
  config?: ResolvedConfig;
  configPath?: string;
  workspaceRoot?: string;
  dataDir?: string;
  plugins?: PluginLoadReport;
  mcpErrors?: Array<{ server: string; message: string }>;
  probe?: (config: ResolvedConfig) => Promise<DoctorCheck[]>;
}

/**
 * Doctor is diagnostics only: it never spends money or sends credentials. A
 * provider probe happens solely when the caller passes `probe` (`--probe`).
 */
export async function runDoctor(input: DoctorInput, version = '0.1.0'): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  if (!input.config) {
    checks.push({
      name: 'config',
      status: 'error',
      message: 'No agent-shell.config.ts found.',
      hint: 'Create ./agent-shell.config.ts or pass --config <path>.',
    });
    return { ok: false, checks, version };
  }

  const config = input.config;
  checks.push({
    name: 'config',
    status: 'ok',
    message: `Loaded ${input.configPath ?? 'in-memory config'}`,
  });

  if (Object.keys(config.providers).length === 0) {
    checks.push({
      name: 'providers',
      status: 'error',
      message: 'No providers configured.',
      hint: 'Add at least one provider entry.',
    });
  }
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.kind === 'scripted') {
      checks.push({ name: `provider:${id}`, status: 'ok', message: 'scripted provider (offline)' });
      continue;
    }
    const variable = provider.apiKey?.variable ?? '';
    const present = revealSecret(provider.apiKey) !== undefined;
    checks.push({
      name: `provider:${id}`,
      status: present ? 'ok' : 'error',
      message: present
        ? `${provider.kind} ready (${variable})`
        : `${provider.kind} missing environment variable ${variable}`,
      ...(!present ? { hint: `export ${variable}=<value>` } : {}),
    });
  }

  if (config.defaults.provider) {
    const providerId = config.defaults.provider.split(':')[0] ?? '';
    if (!(providerId in config.providers)) {
      checks.push({
        name: 'defaults.provider',
        status: 'error',
        message: `defaults.provider "${config.defaults.provider}" refers to unknown provider "${providerId}".`,
      });
    }
  }

  if (input.workspaceRoot) {
    const exists = fs.existsSync(input.workspaceRoot);
    checks.push({
      name: 'workspace',
      status: exists ? 'ok' : 'error',
      message: exists
        ? input.workspaceRoot
        : `Workspace root does not exist: ${input.workspaceRoot}`,
    });
  }

  if (input.dataDir) {
    const writableParent = isWritable(path.dirname(input.dataDir));
    checks.push({
      name: 'dataDir',
      status: writableParent ? 'ok' : 'error',
      message: writableParent ? input.dataDir : `Cannot write to ${path.dirname(input.dataDir)}`,
    });
  }

  if (input.plugins) {
    for (const loaded of input.plugins.loaded) {
      checks.push({
        name: `plugin:${loaded.manifest.name}`,
        status: 'ok',
        message: `${loaded.manifest.version} (api ${loaded.apiVersion}, ${loaded.tools.length} tool${loaded.tools.length === 1 ? '' : 's'})`,
      });
    }
    for (const failed of input.plugins.failed) {
      checks.push({
        name: `plugin:${failed.name ?? path.basename(failed.dir)}`,
        status: 'error',
        message: failed.error.message,
        hint: failed.path,
      });
    }
  }

  for (const [id, server] of Object.entries(config.mcp.servers)) {
    if (!server.enabled) {
      checks.push({ name: `mcp:${id}`, status: 'warn', message: 'disabled' });
      continue;
    }
    if (server.transport === 'stdio') {
      const reachable = isCommandAvailable(server.command) || path.isAbsolute(server.command);
      checks.push({
        name: `mcp:${id}`,
        status: reachable ? 'ok' : 'error',
        message: reachable
          ? `stdio ${server.command}`
          : `stdio command not found on PATH: ${server.command}`,
        ...(!reachable ? { hint: 'Install the server or use an absolute command path.' } : {}),
      });
    } else {
      checks.push({ name: `mcp:${id}`, status: 'ok', message: `http ${server.url}` });
    }
  }

  for (const error of input.mcpErrors ?? []) {
    checks.push({ name: `mcp:${error.server}`, status: 'error', message: error.message });
  }

  if (input.probe) {
    checks.push(...(await input.probe(config)));
  }

  const ok = !checks.some((check) => check.status === 'error');
  return { ok, checks, version };
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function isCommandAvailable(command: string): boolean {
  const separator = process.platform === 'win32' ? ';' : ':';
  const pathVar = process.env['PATH'] ?? '';
  return pathVar
    .split(separator)
    .some((entry) => entry.length > 0 && fs.existsSync(path.join(entry, command)));
}
