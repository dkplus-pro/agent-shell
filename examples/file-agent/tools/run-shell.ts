import { spawn } from 'node:child_process';
import { z } from 'zod';
import { CancelledError, ToolError } from '../../../packages/core/src/errors/index.js';
import { defineTool, type ToolContext } from '../../../packages/core/src/tools/types.js';

export const runShellArgsSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(2_000)
    .describe('Command to run. This example only permits `echo <words>`.'),
});

export type RunShellArgs = z.infer<typeof runShellArgsSchema>;

/**
 * Allowlist, not a denylist: the only program this scenario may ever exec is
 * `echo`. There is no shell involved, so `|`, `;`, `$()` have no special meaning,
 * but they are rejected anyway so a confused model gets a clear error (AGENT.md §4).
 */
const ALLOWED_PROGRAMS = ['echo'] as const;

/** Shell metacharacters are rejected even though nothing here is parsed by a shell. */
const FORBIDDEN = /[;|&`$<>()\n\r\\]/;

const MAX_OUTPUT_BYTES = 64 * 1024;

export type TokenizedCommand = { readonly program: string; readonly args: readonly string[] };

/**
 * Splits a command line into an argv array without a shell. Quotes group words;
 * everything else is literal. The result is what `spawn` receives, so no
 * string-interpolated command is ever executed.
 */
export function tokenizeCommand(command: string): TokenizedCommand {
  // A trailing newline from the model is formatting, not a second command; an
  // embedded one is rejected together with the rest of the shell syntax.
  const trimmed = command.trim();
  if (FORBIDDEN.test(trimmed)) {
    throw new ToolError('run_shell: shell metacharacters are not allowed; pass plain words');
  }
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const char of trimmed) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
  }
  if (quote !== undefined) {
    throw new ToolError('run_shell: unterminated quote in command');
  }
  if (started || current.length > 0) tokens.push(current);

  const [program, ...args] = tokens;
  if (program === undefined || program.length === 0) {
    throw new ToolError('run_shell: empty command');
  }
  return { program, args };
}

/** The child inherits only `PATH`: no secret can leak into a tool process by accident. */
function childEnv(): Record<string, string> {
  const pathValue = process.env['PATH'];
  return { PATH: typeof pathValue === 'string' ? pathValue : '/usr/bin:/bin' };
}

function isAllowedProgram(program: string): boolean {
  return (ALLOWED_PROGRAMS as readonly string[]).includes(program);
}

type Completed = { exitCode: number; stdout: string; stderr: string; truncated: boolean };

function collect(
  stream: NodeJS.ReadableStream | null,
  ctx: ToolContext,
): {
  text: () => string;
  truncated: () => boolean;
} {
  let chunks = '';
  let truncated = false;
  if (stream !== null) {
    stream.setEncoding('utf8');
    stream.on('data', (piece: string) => {
      if (truncated) return;
      chunks += piece;
      if (Buffer.byteLength(chunks, 'utf8') > MAX_OUTPUT_BYTES) {
        truncated = true;
        chunks = chunks.slice(0, MAX_OUTPUT_BYTES);
        ctx.log('warn', 'run_shell: output truncated', { limitBytes: MAX_OUTPUT_BYTES });
      }
    });
  }
  return {
    text: () => chunks,
    truncated: () => truncated,
  };
}

function runCaptured(
  program: string,
  args: readonly string[],
  ctx: ToolContext,
): Promise<Completed> {
  return new Promise<Completed>((resolve, reject) => {
    const child = spawn(program, [...args], {
      cwd: ctx.workspaceRoot,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Cancellation reaches the child through the run's AbortSignal.
      signal: ctx.signal,
    });
    const stdout = collect(child.stdout, ctx);
    const stderr = collect(child.stderr, ctx);

    child.on('error', (error: Error) => {
      if (ctx.signal.aborted) {
        reject(new CancelledError(error.message));
        return;
      }
      reject(new ToolError(`run_shell: ${error.message}`, error));
    });
    child.on('close', (exitCode: number | null, signalName: NodeJS.Signals | null) => {
      if (ctx.signal.aborted) {
        reject(
          new CancelledError(`run_shell: cancelled (${signalName ?? `exit ${String(exitCode)}`})`),
        );
        return;
      }
      if (exitCode === null) {
        reject(new ToolError(`run_shell: killed by ${signalName ?? 'unknown signal'}`));
        return;
      }
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated(),
      });
    });
  });
}

/**
 * Code tool, risk `exec`: two confirmations, and the approval card shows the raw
 * `command`. Execution is always `spawn(program, argv)` with an allowlist —
 * never `exec(command)`, never a string built into a shell line.
 */
export const runShellTool = defineTool({
  name: 'run_shell',
  description:
    'Run an allowlisted command in the workspace. Only `echo <words>` is permitted here.',
  schema: runShellArgsSchema,
  risk: 'exec',
  timeoutMs: 15_000,
  idempotent: true,
  async execute(args, ctx) {
    const input = runShellArgsSchema.parse(args);
    const { program, args: argv } = tokenizeCommand(input.command);
    if (!isAllowedProgram(program)) {
      throw new ToolError(
        `run_shell: "${program}" is not allowlisted (allowed: ${ALLOWED_PROGRAMS.join(', ')})`,
      );
    }

    ctx.log('info', 'run_shell: spawning allowlisted program', { program, argv: [...argv] });
    const result = await runCaptured(program, argv, ctx);
    if (result.exitCode !== 0) {
      throw new ToolError(
        `run_shell: "${program}" exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
    // All fields are always present: `ToolOutput` has no `undefined`, so an
    // optional property here would not type.
    return {
      command: input.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
    };
  },
});
