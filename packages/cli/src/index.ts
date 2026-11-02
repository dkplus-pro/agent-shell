/**
 * `agent-shell` CLI program (docs/03 §1). The CLI contains NO runtime logic:
 * every command parses flags, drives approvals and renders, while execution,
 * events and trace live in @agent-shell/core (docs/01 §5.10, AGENT.md §2/§13).
 */
import { Command, CommanderError } from 'commander';
import { SHELL_VERSION, exitCodeFor } from '@agent-shell/core';
import { chatCommand, resumeSessionCommand } from './commands/chat.js';
import { configValidateCommand, doctorCommand } from './commands/doctor.js';
import {
  mcpJsonLines,
  mcpLines,
  mcpToolLines,
  parseToolSource,
  pluginLines,
  pluginsJsonLines,
  providerLines,
  providersJsonLines,
  sessionsJsonLines,
  sessionsLines,
  toolsJsonLines,
  toolsLines,
} from './commands/inspect.js';
import { runCommand } from './commands/run.js';
import { traceListCommand, traceShowCommand, traceTailCommand } from './commands/trace.js';
import { installSigintBus } from './cancel.js';
import { createContext } from './context.js';
import { addGlobalOptions, toGlobalFlags, type GlobalFlags } from './flags.js';
import { createRenderer, type Renderer } from './render/renderer.js';

export interface ActionContext {
  flags: GlobalFlags;
  renderer: Renderer;
  args: string[];
  opts: Record<string, unknown>;
}

interface ExitState {
  exitCode: number;
}

export function buildProgram(state: ExitState): Command {
  const program = new Command('agent-shell');
  program
    .description('Local-first, business-agnostic agent runtime shell')
    .version(SHELL_VERSION, '--version', 'show the shell version')
    .exitOverride();

  const register = (
    command: Command,
    action: (context: ActionContext) => Promise<number>,
  ): Command => {
    addGlobalOptions(command);
    command.exitOverride();
    command.action(async (...actionArgs: unknown[]) => {
      const commandObj = findCommand(actionArgs);
      const raw = commandObj.optsWithGlobals() as Record<string, unknown>;
      const flags = toGlobalFlags(raw);
      const renderer = createRenderer(flags);
      state.exitCode = await action({ flags, renderer, args: collectArgs(actionArgs), opts: raw });
    });
    return command;
  };

  // run <task> — one-shot execution (docs/03 §1, §4, §5)
  register(
    program
      .command('run')
      .argument('<task...>', 'the task to execute in one shot')
      .option('--quiet', 'print only the final answer')
      .description('execute a single task and exit'),
    async ({ flags, renderer, args }) => await runCommand(flags, args.join(' '), renderer),
  );

  // chat — the default command
  register(
    program
      .command('chat', { isDefault: true })
      .argument('[task...]', 'optional first message for the REPL')
      .description('enter the interactive REPL (default command)'),
    async ({ flags, renderer, args }) => await chatCommand(flags, args.join(' '), renderer),
  );

  // trace list / show / tail
  const trace = program.command('trace').description('inspect recorded traces');
  trace.exitOverride();
  register(
    trace.command('list').description('list recorded runs'),
    async ({ flags, renderer }) => await traceListCommand(flags, renderer),
  );
  register(
    trace
      .command('show')
      .argument('<run-id>', 'run id (full or unambiguous prefix)')
      .option('--raw', 'print the JSONL lines verbatim')
      .description("render the run's span tree"),
    async ({ flags, renderer, args, opts }) =>
      await traceShowCommand(flags, renderer, args[0] ?? '', { raw: opts['raw'] === true }),
  );
  register(
    trace
      .command('tail')
      .argument('<run-id>', 'run id to follow')
      .description('follow new events for a run'),
    async ({ flags, renderer, args }) => await traceTailCommand(flags, renderer, args[0] ?? ''),
  );

  // tools list [--source code|plugin|mcp|runtime]
  const tools = program.command('tools').description('inspect the tool registry');
  tools.exitOverride();
  register(
    tools
      .command('list')
      .option('--source <source>', 'filter by tool source (code|plugin|mcp)')
      .description('list registered tools'),
    async ({ flags, renderer, opts }) => {
      const source = parseToolSource(
        typeof opts['source'] === 'string' ? opts['source'] : undefined,
      );
      const ctx = await createContext({ flags, interactive: false });
      try {
        renderer.lines(
          renderer.mode === 'json'
            ? toolsJsonLines(ctx.registry, source)
            : toolsLines(ctx.registry, source),
        );
        return 0;
      } finally {
        await ctx.close();
      }
    },
  );

  // plugins list
  const plugins = program.command('plugins').description('inspect plugins');
  plugins.exitOverride();
  register(
    plugins.command('list').description('list plugins and their load status'),
    async ({ flags, renderer }) => {
      const ctx = await createContext({ flags, interactive: false });
      try {
        renderer.lines(renderer.mode === 'json' ? pluginsJsonLines(ctx) : pluginLines(ctx));
        return 0;
      } finally {
        await ctx.close();
      }
    },
  );

  // mcp list / mcp status
  const mcp = program.command('mcp').description('inspect MCP servers and tools');
  mcp.exitOverride();
  register(
    mcp.command('list').description('list MCP servers and their tools'),
    async ({ flags, renderer }) => {
      const ctx = await createContext({ flags, interactive: false });
      try {
        if (renderer.mode === 'json') renderer.lines(mcpJsonLines(ctx));
        else renderer.lines([...mcpLines(ctx), '', ...mcpToolLines(ctx)]);
        return 0;
      } finally {
        await ctx.close();
      }
    },
  );
  register(
    mcp.command('status').description('connection status and last errors per server'),
    async ({ flags, renderer }) => {
      const ctx = await createContext({ flags, interactive: false });
      try {
        if (renderer.mode === 'json') renderer.lines(mcpJsonLines(ctx));
        else renderer.lines(mcpLines(ctx));
        return 0;
      } finally {
        await ctx.close();
      }
    },
  );

  // providers list
  const providers = program.command('providers').description('inspect configured providers');
  providers.exitOverride();
  register(
    providers.command('list').description('list providers, models and capabilities'),
    async ({ flags, renderer }) => {
      const ctx = await createContext({ flags, interactive: false });
      try {
        renderer.lines(renderer.mode === 'json' ? providersJsonLines(ctx) : providerLines(ctx));
        return 0;
      } finally {
        await ctx.close();
      }
    },
  );

  // sessions list / resume
  const sessions = program.command('sessions').description('list or resume sessions');
  sessions.exitOverride();
  register(
    sessions.command('list').description('list recorded sessions'),
    async ({ flags, renderer }) => {
      const ctx = await createContext({ flags, interactive: false });
      try {
        renderer.lines(
          renderer.mode === 'json' ? await sessionsJsonLines(ctx) : await sessionsLines(ctx),
        );
        return 0;
      } finally {
        await ctx.close();
      }
    },
  );
  register(
    sessions
      .command('resume')
      .argument('<id>', 'session id')
      .description('resume a session in the REPL'),
    async ({ flags, renderer, args }) => await resumeSessionCommand(flags, args[0] ?? '', renderer),
  );

  // doctor
  register(
    program
      .command('doctor')
      .option('--probe', 'build provider handles to probe configuration (never sends a request)')
      .description('diagnose config, secrets, plugins and MCP'),
    async ({ flags, renderer, opts }) =>
      await doctorCommand(flags, renderer, { probe: opts['probe'] === true }),
  );

  // config validate
  const config = program.command('config').description('configuration utilities');
  config.exitOverride();
  register(
    config
      .command('validate')
      .description('validate the effective configuration without running anything'),
    async ({ flags, renderer }) => await configValidateCommand(flags, renderer),
  );

  return program;
}

/** Commander shifts action params: (…args, options, command). Find the Command. */
function findCommand(actionArgs: unknown[]): Command {
  for (let index = actionArgs.length - 1; index >= 0; index -= 1) {
    const candidate = actionArgs[index];
    if (candidate instanceof Command) return candidate;
  }
  throw new Error('internal: action invoked without a Command');
}

/** Everything before (options, command) are the declared arguments. */
function collectArgs(actionArgs: unknown[]): string[] {
  const args: string[] = [];
  for (const candidate of actionArgs) {
    if (
      candidate instanceof Command ||
      (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate))
    ) {
      break;
    }
    if (Array.isArray(candidate)) {
      args.push(...candidate.map((item) => String(item)));
      continue;
    }
    args.push(String(candidate));
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  // Installed first so a Ctrl+C during config/plugin/MCP startup is handled by
  // the shell (exit 130) instead of killing the process with a signal.
  installSigintBus();
  const state: ExitState = { exitCode: 0 };
  const program = buildProgram(state);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const flags = toGlobalFlags(scanFallbackFlags(argv));
    const renderer = createRenderer(flags);
    renderer.error(error instanceof Error ? error.message : String(error));
    if (flags.verbose && error instanceof Error && error.stack !== undefined)
      renderer.error(error.stack);
    return exitCodeFor(error);
  }
}

function scanFallbackFlags(argv: string[]): Record<string, unknown> {
  return {
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
    color: !argv.includes('--no-color'),
    quiet: argv.includes('--quiet'),
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
