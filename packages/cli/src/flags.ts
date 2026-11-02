/**
 * Global flag surface — exactly docs/03-cli-and-trace.md §1. Every leaf command
 * declares them itself because the documented call shape places flags AFTER the
 * subcommand (`agent-shell run <task> --json`).
 */
import type { Command } from 'commander';

export interface GlobalFlags {
  config?: string;
  workspace?: string;
  traceDir?: string;
  provider?: string;
  preset?: string;
  session?: string;
  yolo: boolean;
  allowOutsideWorkspace: boolean;
  noColor: boolean;
  verbose: boolean;
  json: boolean;
  script?: string;
  quiet: boolean;
}

export function addGlobalOptions(command: Command): Command {
  return command
    .option('--config <path>', 'path to agent-shell.config.ts')
    .option('--workspace <path>', 'override workspaceRoot')
    .option('--trace-dir <path>', 'override trace/data directory')
    .option('--provider <provider:model>', 'override the default model')
    .option('--preset <name>', 'select a run preset')
    .option('--session <id>', 'session id (ses_...) to use or resume')
    .option('--yolo', 'skip approvals (hard-deny still applies)')
    .option('--allow-outside-workspace', 'let file tools leave the workspace')
    .option('--no-color', 'disable ANSI colors')
    .option('--verbose', 'extra diagnostics')
    .option('--json', 'NDJSON events on stdout only')
    .option('--script <file>', 'scripted run: approvals and turns from JSON');
}

/** Commander hands us `Record<string, unknown>`; narrow once, centrally. */
export function toGlobalFlags(raw: Record<string, unknown>): GlobalFlags {
  return {
    config: typeof raw['config'] === 'string' ? raw['config'] : undefined,
    workspace: typeof raw['workspace'] === 'string' ? raw['workspace'] : undefined,
    traceDir: typeof raw['traceDir'] === 'string' ? raw['traceDir'] : undefined,
    provider: typeof raw['provider'] === 'string' ? raw['provider'] : undefined,
    preset: typeof raw['preset'] === 'string' ? raw['preset'] : undefined,
    session: typeof raw['session'] === 'string' ? raw['session'] : undefined,
    yolo: raw['yolo'] === true,
    allowOutsideWorkspace: raw['allowOutsideWorkspace'] === true,
    // commander's `--no-color` arrives as color:false
    noColor: raw['color'] === false || raw['noColor'] === false,
    verbose: raw['verbose'] === true,
    json: raw['json'] === true,
    script: typeof raw['script'] === 'string' ? raw['script'] : undefined,
    quiet: raw['quiet'] === true,
  };
}

export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]{1,200}$/;

export function assertSessionId(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new Error(`Invalid session id "${value}": ids must match ${SESSION_ID_PATTERN.source}.`);
  }
  return value;
}
