/**
 * Shared E2E harness (docs/04 §2.5): throwaway workspace per test, symlinked
 * node_modules so `node --import tsx` resolves, scripted "fake" providers with
 * inline model scripts, and a dependency-free config file (the config uses
 * plain objects; core validates).
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/cli/test/e2e -> repo root is four levels up.
export const REPO = path.resolve(HERE, '..', '..', '..', '..');
export const CLI_ENTRY = path.join(REPO, 'packages', 'cli', 'src', 'index.ts');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Workspace {
  dir: string;
  configPath: string;
  traceDir: string;
  cleanup(): void;
}

export interface Step {
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  streamChunks?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: { name: string; message: string; code?: string };
}

export interface ConfigSpec {
  /** model id -> consumed steps. providers.fake exposes all of them. */
  scripts: Record<string, Step[]>;
  limits?: Record<string, unknown>;
  approvals?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  presets?: Record<string, unknown>;
  /** extra provider entries merged into providers (e.g. a leaky scripted one). */
  extraProviders?: Record<string, string>;
}

const CODE_TOOLS = `
import { z } from "zod";

const read_file = {
  name: "read_file",
  description: "Read a UTF-8 file inside the workspace",
  risk: "read",
  schema: z.object({ path: z.string().min(1) }),
  execute: async (args, ctx) => {
    const fsp = await import("node:fs/promises");
    return await fsp.readFile(ctx.resolveWorkspacePath(args.path), "utf8");
  },
};
const write_file = {
  name: "write_file",
  description: "Write a UTF-8 file inside the workspace",
  risk: "write",
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  execute: async (args, ctx) => {
    const fsp = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const target = ctx.resolveWorkspacePath(args.path);
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    await fsp.writeFile(target, args.content);
    return "wrote " + args.path;
  },
};
const run_shell = {
  name: "run_shell",
  description: "Run a shell command and return stdout",
  risk: "exec",
  schema: z.object({ command: z.string().min(1) }),
  execute: async (args, ctx) => {
    const cp = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      const child = cp.spawn("sh", ["-c", args.command], { signal: ctx.signal });
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error("exit " + String(code)))));
    });
  },
};
const sleep_tool = {
  name: "sleep_tool",
  description: "Sleep for a while (cancellation fixture)",
  risk: "exec",
  schema: z.object({ ms: z.number().int().nonnegative() }),
  execute: async (args) => {
    await new Promise((resolve) => setTimeout(resolve, args.ms ?? 10000));
    return "slept";
  },
};
`;

function linkDep(modulesDir: string, name: string, target: string): void {
  fs.symlinkSync(fs.realpathSync(target), path.join(modulesDir, name), 'dir');
}

export function makeWorkspace(spec: ConfigSpec): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shell-cli-'));
  // `node --import tsx` resolves tsx relative to the process cwd and the config
  // file imports zod; a minimal node_modules keeps E2E runs hermetic but resolvable.
  const modules = path.join(dir, 'node_modules');
  fs.mkdirSync(modules);
  linkDep(modules, 'tsx', path.join(REPO, 'node_modules', 'tsx'));
  linkDep(modules, 'zod', path.join(REPO, 'packages', 'cli', 'node_modules', 'zod'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes', 'a.md'), 'hello world\n');

  const models = Object.keys(spec.scripts);
  const scripts = Object.fromEntries(
    models.map((model) => [`fake:${model}`, { version: 1, steps: spec.scripts[model] }]),
  );
  const providers: Record<string, unknown> = {
    fake: { kind: 'scripted', models, scripts },
    ...Object.fromEntries(
      Object.entries(spec.extraProviders ?? {}).map(([id, model]) => [
        id,
        { kind: 'scripted', models: [model], scripts: {} },
      ]),
    ),
  };
  const source = `${CODE_TOOLS}
export default {
  providers: ${JSON.stringify(providers, null, 2)},
  defaults: { provider: "fake:${models[0] ?? 'plain'}", preset: "single", agent: "default" },
  workspaceRoot: ${JSON.stringify(dir)},
  checkpointer: "memory",
  tools: { code: [read_file, write_file, run_shell, sleep_tool] },
  agents: ${JSON.stringify(
    spec.agents ?? {
      default: {
        name: 'default',
        prompt: 'Use tools when asked.',
        tools: ['read_file', 'write_file', 'run_shell', 'sleep_tool', 'runtime__spawn_subagent'],
      },
    },
    null,
    2,
  )},
  presets: ${JSON.stringify(spec.presets ?? { single: { kind: 'single', agent: 'default' } }, null, 2)},
  approvals: ${JSON.stringify(spec.approvals ?? { timeoutMs: 0 })},
  limits: ${JSON.stringify(spec.limits ?? { maxSteps: 12, tokenBudget: 200000, maxWallTimeMs: 60000, maxSubagents: 4, maxSubagentDepth: 1 })},
  trace: { dataDir: ${JSON.stringify(path.join(dir, '.agent-shell'))} },
  plugins: { enabled: false, dirs: [] },
};
`;
  const configPath = path.join(dir, 'agent-shell.config.ts');
  fs.writeFileSync(configPath, source);
  return {
    dir,
    configPath,
    traceDir: path.join(dir, '.agent-shell', 'traces'),
    cleanup(): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function baseArgs(ws: Workspace): string[] {
  return ['--config', ws.configPath, '--workspace', ws.dir];
}

export async function cli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: string },
): Promise<CliResult> {
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, HOME: opts.cwd, AGENT_SHELL_NO_COLOR: '1', ...(opts.env ?? {}) },
        encoding: 'utf8',
        maxBuffer: 24 * 1024 * 1024,
        timeout: 120_000,
      },
      (error, stdout, stderr) => {
        const failure = error as
          (NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) | null;
        const code = typeof failure?.code === 'number' ? failure.code : failure ? 1 : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

export function cliRun(
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
): {
  result: Promise<CliResult>;
  interruptAfter(ms: number): void;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.cwd, AGENT_SHELL_NO_COLOR: '1', ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<CliResult>((resolve) => {
    child.on('close', (code, signal) =>
      resolve({ code: code ?? (signal !== null ? 128 : 1), stdout, stderr }),
    );
  });
  return {
    result,
    interruptAfter(ms: number): void {
      setTimeout(() => child.kill('SIGINT'), ms).unref?.();
    },
  };
}

/** Every stdout line of a --json run must be a valid NDJSON event. */
export function ndjsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function traceFiles(ws: Workspace): string[] {
  if (!fs.existsSync(ws.traceDir)) return [];
  const files: string[] = [];
  for (const session of fs.readdirSync(ws.traceDir)) {
    const dir = path.join(ws.traceDir, session);
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.jsonl')) files.push(path.join(dir, file));
    }
  }
  return files;
}
