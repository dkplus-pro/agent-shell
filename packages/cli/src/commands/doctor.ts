/**
 * `doctor` and `config validate` (docs/03 §1). Diagnostics come from core's
 * runDoctor; the CLI only assembles inputs and renders. `--probe` builds model
 * handles through the provider registry — construction and key checks stay in
 * core, and no prompt is ever sent (doctor never spends money, AGENT.md §5).
 */
import {
  ConfigError,
  SHELL_VERSION,
  discoverConfigPath,
  loadConfig,
  runDoctor,
  type DoctorCheck,
} from '@agent-shell/core';
import { createContext } from '../context.js';
import type { GlobalFlags } from '../flags.js';
import { formatTable, type Renderer } from '../render/renderer.js';

export async function doctorCommand(
  flags: GlobalFlags,
  renderer: Renderer,
  opts: { probe: boolean },
): Promise<number> {
  const ctx = await createContext({ flags, interactive: false, requireConfig: false });
  try {
    const hasConfig = ctx.configPath !== undefined;
    const report = await runDoctor(
      {
        ...(hasConfig ? { config: ctx.config, configPath: ctx.configPath } : {}),
        workspaceRoot: ctx.workspaceRoot,
        dataDir: ctx.dataDir,
        ...(hasConfig
          ? { plugins: ctx.pluginReport, mcpErrors: ctx.mcp.errors }
          : { mcpErrors: ctx.mcp.errors }),
        ...(opts.probe && hasConfig ? { probe: () => probeProviders(ctx) } : {}),
      },
      SHELL_VERSION,
    );

    if (renderer.mode === 'json') {
      renderer.lines([JSON.stringify({ ok: report.ok, version: report.version })]);
      for (const check of report.checks) renderer.lines([JSON.stringify(check)]);
    } else {
      renderer.lines(
        formatTable(
          ['', 'CHECK', 'MESSAGE', 'HINT'],
          report.checks.map((check) => [
            statusMark(check.status),
            check.name,
            check.message,
            check.hint ?? '',
          ]),
        ),
      );
    }
    return report.ok ? 0 : 2;
  } finally {
    await ctx.close();
  }
}

async function probeProviders(
  ctx: Awaited<ReturnType<typeof createContext>>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const provider of ctx.providers.list()) {
    if (provider.kind === 'scripted') continue;
    const model = provider.config.models[0];
    const ref = model === undefined ? provider.id : `${provider.id}:${model}`;
    try {
      await ctx.providers.create(ref);
      checks.push({
        name: `probe:${provider.id}`,
        status: 'ok',
        message: `handle for ${ref} built (no request sent)`,
      });
    } catch (error) {
      checks.push({
        name: `probe:${provider.id}`,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return checks;
}

function statusMark(status: string): string {
  switch (status) {
    case 'ok':
      return '✓';
    case 'warn':
      return '!';
    default:
      return '✗';
  }
}

export async function configValidateCommand(
  flags: GlobalFlags,
  renderer: Renderer,
): Promise<number> {
  // `config validate` must not start any runtime: discovery + core validation only.
  // ConfigError propagates and index.ts maps it to exit 2 (docs/03 §10).
  const configPath = discoverConfigPath({ explicit: flags.config });
  if (configPath === undefined) {
    throw new ConfigError(
      'No agent-shell.config.ts found. Create one in the current directory, place it at ~/.agent-shell/agent-shell.config.ts, or pass --config <path>.',
    );
  }
  const loaded = await loadConfig(configPath);
  const config = loaded.config;
  const toolNames = config.tools.code.map((tool) => tool.name);
  if (renderer.mode === 'json') {
    renderer.lines([
      JSON.stringify({
        ok: true,
        path: loaded.filePath,
        providers: Object.keys(config.providers),
        agents: Object.keys(config.agents),
        presets: Object.keys(config.presets),
        tools: toolNames,
      }),
    ]);
  } else {
    renderer.lines([
      `✓ 配置有效: ${loaded.filePath}`,
      `providers=${Object.keys(config.providers).length} agents=${Object.keys(config.agents).length} ` +
        `presets=${Object.keys(config.presets).length} code-tools=${toolNames.length}`,
    ]);
  }
  return 0;
}
