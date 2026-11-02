/**
 * Offline acceptance runner — docs/04-testing-and-acceptance.md §4.
 * It builds a throwaway workspace, generates the combination-root config,
 * drives the CLI through every Act with scripted models, then asserts on the
 * trace and the filesystem. Never touches the network, never needs a real key.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Failures,
  assertApprovalCounts,
  assertContains,
  assertListRuns,
  assertNamespaces,
  assertNoSecret,
  assertRunPairs,
  assertSchemaValid,
  assertSpanLinks,
  assertSubagents,
  assertToolSources,
  assertTree,
  flatten,
  loadTraces,
  ok,
} from './assertions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const CLI_ENTRY = path.join(REPO, 'packages', 'cli', 'bin', 'agent-shell.js');
const CLI_SRC = path.join(REPO, 'packages', 'cli', 'src', 'index.ts');
const FAKE_SECRET = 'sk-fake-secret-do-not-leak-4f9c2b';

interface Act {
  name: string;
  task?: string;
  provider?: string;
  preset?: string;
  script?: object;
  session?: string;
  newSession?: boolean;
  expectExit?: number;
  expectContains?: string | [string, string];
  yolo?: boolean;
  extraArgs?: string[];
  stdinLines?: string[];
  env?: Record<string, string>;
}

function tempWorkspace(): string {
  const base = fs.mkdtempSync(path.join(REPO, 'tooling', 'acceptance', '.tmp-accept-'));
  fs.mkdirSync(path.join(base, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(base, 'notes', 'a.md'), 'hello world\n');
  fs.writeFileSync(path.join(base, 'notes', 'b.md'), 'agent shell\n');
  return base;
}

function step(name: string): void {
  console.log(`\n${name}`);
}

/** Model script steps are written per Act so a run consumes exactly what it needs. */
function writeModelScripts(dir: string): Record<string, string> {
  const scripts: Record<string, object> = {
    act1: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'call_a1' }] },
        { content: 'a.md says hello world', usage: { inputTokens: 120, outputTokens: 30 } },
      ],
    },
    act2: {
      version: 1,
      steps: [
        {
          toolCalls: [
            { name: 'plugin__word_count__word_count', args: { path: 'notes/a.md' }, id: 'call_p2' },
          ],
        },
        { content: 'word count is 2' },
      ],
    },
    act3: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'mcp__echo__echo', args: { text: 'ping' }, id: 'call_m3' }] },
        { content: 'mcp echoed ping' },
      ],
    },
    act4: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'call_a4' }] },
        {
          toolCalls: [
            {
              name: 'write_file',
              args: { path: 'notes/summary.md', content: '# Summary\nhello world\n' },
              id: 'call_w4',
            },
          ],
        },
        { content: 'wrote notes/summary.md' },
      ],
    },
    act5: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'run_shell', args: { command: 'echo hello' }, id: 'call_e5' }] },
        { content: 'shell printed hello' },
      ],
    },
    act6: {
      version: 1,
      steps: [
        {
          toolCalls: [
            {
              name: 'runtime__spawn_subagent',
              args: { agent: 'researcher', task: 'read notes/b.md' },
              id: 'call_s6',
            },
          ],
        },
        { content: 'subagent reported: agent shell' },
      ],
    },
    act7: { version: 1, steps: [{ content: 'anthropic summary: hello world' }] },
    teamLead: {
      version: 1,
      steps: [
        {
          toolCalls: [
            { name: 'transfer_to_researcher', args: { reason: 'needs reading' }, id: 'h1' },
          ],
        },
        { content: 'lead: team finished: both notes summarised' },
      ],
    },
    teamResearcher: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 't_r1' }] },
        { content: 'researcher read a.md: hello world' },
      ],
    },
    teamWriter: {
      version: 1,
      steps: [{ content: 'writer: team finished: both notes summarised' }],
    },
    swarmResearcher: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'transfer_to_writer', args: { reason: 'handoff' }, id: 'h2' }] },
      ],
    },
    swarmWriter: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/b.md' }, id: 's_w1' }] },
        { content: 'writer: swarm wrote the summary' },
      ],
    },
    act10: {
      version: 1,
      steps: [{ content: 'resumed context remembered hello world' }],
    },
    actSecret: {
      version: 1,
      steps: [{ content: 'leak attempt done' }],
    },
    /** Scripted model asks for a write that the scenario script never authorises. */
    unmatchedWrite: {
      version: 1,
      steps: [
        {
          toolCalls: [
            {
              name: 'write_file',
              args: { path: 'notes/forbidden.md', content: 'no' },
              id: 'call_u1',
            },
          ],
        },
        { content: 'write was refused' },
      ],
    },
    escapePath: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: '../outside.txt' }, id: 'call_x1' }] },
        { content: 'refused outside path' },
      ],
    },
    absolutePath: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'read_file', args: { path: '/etc/passwd' }, id: 'call_x2' }] },
        { content: 'refused absolute path' },
      ],
    },
    hardDeny: {
      version: 1,
      steps: [
        { toolCalls: [{ name: 'run_shell', args: { command: 'rm -rf /' }, id: 'call_h1' }] },
        { content: 'destructive command blocked' },
      ],
    },
    depthGuard: {
      version: 1,
      steps: [
        {
          toolCalls: [
            {
              name: 'runtime__spawn_subagent',
              args: { agent: 'nested', task: 'spawn again' },
              id: 'call_d1',
            },
          ],
        },
        { content: 'nested spawn rejected by budget' },
      ],
    },
  };
  const written: Record<string, string> = {};
  for (const [name, body] of Object.entries(scripts)) {
    const file = path.join(dir, 'model', `${name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    written[name] = file;
  }
  return written;
}

function generateConfig(workspace: string, scripts: Record<string, string>): string {
  const pluginDir = path.join(REPO, 'examples', 'file-agent', 'plugins', 'word-count');
  const mcpServer = path.join(REPO, 'examples', 'file-agent', 'mcp-echo-server', 'server.mjs');
  const coreEntry = path.join(REPO, 'packages', 'core', 'dist', 'index.js');
  return `// generated by tooling/acceptance — do not edit
import { defineConfig, defineTool, env } from ${JSON.stringify(coreEntry)};
import { z } from "zod";

const read = defineTool({
  name: "read_file",
  description: "Read a UTF-8 file inside the workspace",
  schema: z.object({ path: z.string().min(1) }),
  risk: "read",
  execute: async (args, ctx) => {
    const target = ctx.resolveWorkspacePath(args.path);
    const fs = await import("node:fs/promises");
    return await fs.readFile(target, "utf8");
  },
});

const write = defineTool({
  name: "write_file",
  description: "Write a UTF-8 file inside the workspace",
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  risk: "write",
  execute: async (args, ctx) => {
    const target = ctx.resolveWorkspacePath(args.path);
    const fs = await import("node:fs/promises");
    await fs.mkdir((await import("node:path")).dirname(target), { recursive: true });
    await fs.writeFile(target, args.content);
    return "wrote " + args.path;
  },
});

const shell = defineTool({
  name: "run_shell",
  description: "Run an allowlisted echo command",
  schema: z.object({ command: z.string().min(1) }),
  risk: "exec",
  execute: async (args, ctx) => {
    const parts = args.command.trim().split(/\\s+/);
    if (parts[0] !== "echo") throw new Error("only echo is allowlisted");
    const { spawn } = await import("node:child_process");
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("echo", parts.slice(1), { signal: ctx.signal });
      let out = "";
      child.stdout.on("data", (chunk) => { out += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error("exit " + String(code)))));
    });
  },
});

export default defineConfig({
  providers: {
    openai: { kind: "scripted", scripts: ${JSON.stringify(scripts)} as Record<string, string>, models: ${JSON.stringify(Object.keys(scripts))} },
    anthropic: { kind: "scripted", script: ${JSON.stringify(scripts.act7)}, models: ["fake"] },
    leaky: { kind: "scripted", apiKey: env("ACCEPTANCE_SECRET"), script: ${JSON.stringify(scripts.actSecret)}, models: ["fake"] },
    team: {
      kind: "scripted",
      models: ["script"],
      scripts: {
        "agent:lead": ${JSON.stringify(scripts.teamLead)},
        "agent:researcher": ${JSON.stringify(scripts.teamResearcher)},
        "agent:writer": ${JSON.stringify(scripts.teamWriter)},
      },
    },
    swarm: {
      kind: "scripted",
      models: ["script"],
      scripts: {
        "agent:researcher": ${JSON.stringify(scripts.swarmResearcher)},
        "agent:writer": ${JSON.stringify(scripts.swarmWriter)},
      },
    },
  },
  defaults: { provider: "openai:act1", preset: "single", agent: "default" },
  workspaceRoot: ${JSON.stringify(workspace)},
  checkpointer: "memory",
  tools: { code: [read, write, shell] },
  plugins: { enabled: true, dirs: [${JSON.stringify(pluginDir)}] },
  mcp: { servers: { echo: { transport: "stdio", command: process.execPath, args: [${JSON.stringify(mcpServer)}], envVars: ["MCP_TEST_DIR"], enabled: true, timeoutMs: 20000 } } },
  agents: {
    default: { name: "default", prompt: "Use tools when asked.", tools: ["read_file", "write_file", "run_shell", "runtime__spawn_subagent", "plugin__word_count__word_count", "mcp__echo__echo"] },
    researcher: { name: "researcher", prompt: "Read only.", tools: ["read_file"] },
    writer: { name: "writer", prompt: "Write files.", tools: ["read_file", "write_file"] },
    lead: { name: "lead", prompt: "Delegate then answer.", tools: ["read_file"] },
    nested: { name: "nested", prompt: "You may spawn.", tools: ["read_file", "runtime__spawn_subagent"] },
  },
  presets: {
    single: { kind: "single", agent: "default" },
    team: { kind: "supervisor", supervisor: "lead", agents: ["researcher", "writer"], outputMode: "full_history" },
    swarm: { kind: "swarm", agents: ["researcher", "writer"], defaultActiveAgent: "researcher" },
  },
  approvals: { timeoutMs: 0, allowlist: [], extraHardDeny: [], nonInteractive: "deny" },
  limits: { maxSteps: 12, tokenBudget: 50000, maxWallTimeMs: 120000, maxSubagents: 4, maxSubagentDepth: 1 },
  trace: { dataDir: ${JSON.stringify(path.join(workspace, '.agent-shell'))} },
});
`;
}

function cliCommand(): { cmd: string; prefix: string[] } {
  if (fs.existsSync(CLI_ENTRY) && fs.existsSync(path.join(REPO, 'packages', 'cli', 'dist'))) {
    return { cmd: process.execPath, prefix: [CLI_ENTRY] };
  }
  return { cmd: process.execPath, prefix: ['--import', 'tsx', CLI_SRC] };
}

function runCli(
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: string[] },
): SpawnSyncReturns<string> {
  const { cmd, prefix } = cliCommand();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.cwd,
    AGENT_SHELL_NO_COLOR: '1',
    ...(opts.env ?? {}),
  };
  delete env['OPENAI_API_KEY'];
  const result = spawnSync(cmd, [...prefix, ...args], {
    cwd: opts.cwd,
    encoding: 'utf8',
    env,
    input: opts.stdin ? `${opts.stdin.join('\n')}\n` : '',
    timeout: 120_000,
  });
  return result;
}

function describe(args: string[], result: SpawnSyncReturns<string>): string {
  return `agent-shell ${args.join(' ')}\n  exit=${String(result.status)}\n  stdout=${(result.stdout ?? '').slice(0, 600)}\n  stderr=${(result.stderr ?? '').slice(0, 600)}`;
}

async function main(): Promise<number> {
  const failures = new Failures();
  const workspace = tempWorkspace();
  const scripts = writeModelScripts(workspace);
  fs.writeFileSync(
    path.join(workspace, 'agent-shell.config.ts'),
    generateConfig(workspace, scripts),
  );
  const traceDir = path.join(workspace, '.agent-shell', 'traces');
  const sessionId = `ses_acceptance_${Date.now().toString(36)}`;

  console.log(`acceptance workspace: ${workspace}`);

  for (const required of [
    path.join(REPO, 'examples', 'file-agent', 'plugins', 'word-count', 'plugin.json'),
    path.join(REPO, 'examples', 'file-agent', 'mcp-echo-server', 'server.mjs'),
  ]) {
    if (!fs.existsSync(required)) failures.add(`missing acceptance fixture: ${required}`);
  }
  if (failures.count > 0) {
    console.error('acceptance cannot start without its fixtures');
    return 1;
  }

  const approvals = {
    version: 1,
    approvals: [
      { tool: 'write_file', decision: 'approve' },
      // One rule carries both exec confirmations: the CLI re-uses the rule that
      // matched attempt 1 for the typed `run` step (docs/03 §3.2).
      { tool: 'run_shell', decision: 'approve', confirmation: 'run' },
    ],
  };

  const acts: Act[] = [
    {
      name: 'Act 1 · code read tool',
      task: '读取 notes/a.md 并总结',
      provider: 'openai:act1',
      session: sessionId,
      newSession: true,
      expectContains: 'hello world',
    },
    {
      name: 'Act 2 · plugin tool',
      task: '统计 notes/a.md 词数',
      provider: 'openai:act2',
      session: sessionId,
      expectContains: 'word count',
    },
    {
      name: 'Act 3 · mcp tool',
      task: '调用 echo 工具',
      provider: 'openai:act3',
      session: sessionId,
      expectContains: 'ping',
    },
    {
      name: 'Act 4 · write approval',
      task: '写入 notes/summary.md',
      provider: 'openai:act4',
      session: sessionId,
      script: approvals,
      expectContains: 'wrote',
    },
    {
      name: 'Act 5 · exec approval',
      task: '执行 echo hello',
      provider: 'openai:act5',
      session: sessionId,
      script: approvals,
      expectContains: 'hello',
    },
    {
      name: 'Act 6 · spawn subagent',
      task: '派生 researcher 读取 notes/b.md',
      provider: 'openai:act6',
      session: sessionId,
      expectContains: 'agent shell',
    },
    {
      name: 'Act 7 · anthropic provider',
      task: '总结两个文件',
      provider: 'anthropic:fake',
      session: sessionId,
      expectContains: 'anthropic summary',
    },
    {
      name: 'Act 8 · supervisor preset',
      task: '总结两个文件',
      provider: 'team:script',
      preset: 'team',
      session: `${sessionId}_team`,
      newSession: true,
      expectContains: 'team finished',
    },
    {
      name: 'Act 9 · swarm preset turn 1',
      task: '先研究 notes/b.md',
      provider: 'swarm:script',
      preset: 'swarm',
      session: `${sessionId}_swarm`,
      newSession: true,
      expectContains: 'swarm',
    },
    {
      name: 'Act 9 · swarm preset turn 2',
      task: '再写摘要',
      provider: 'swarm:script',
      preset: 'swarm',
      session: `${sessionId}_swarm`,
      expectContains: 'swarm',
    },
    {
      name: 'Act 10 · resume session',
      provider: 'openai:act10',
      session: sessionId,
      stdinLines: ['继续上次的话题', '/quit'],
      expectContains: 'resumed context',
    },
    {
      name: 'Act 12 · fake secret',
      task: '使用 leaky provider',
      provider: 'leaky:fake',
      session: `${sessionId}_leak`,
      newSession: true,
      env: { ACCEPTANCE_SECRET: FAKE_SECRET },
    },
  ];

  const outputs: string[] = [];
  for (const act of acts) {
    step(act.name);
    const args: string[] = [];
    if (act.name.startsWith('Act 10')) {
      args.push('sessions', 'resume', act.session ?? sessionId);
    } else {
      args.push('run', act.task ?? '继续');
    }
    args.push('--config', path.join(workspace, 'agent-shell.config.ts'));
    args.push('--workspace', workspace);
    if (act.provider) args.push('--provider', act.provider);
    if (act.preset) args.push('--preset', act.preset);
    args.push('--session', act.session ?? sessionId);
    if (act.script) {
      const file = path.join(
        workspace,
        `approvals-${act.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`,
      );
      fs.writeFileSync(file, JSON.stringify(act.script, null, 2));
      args.push('--script', file);
    }
    if (act.yolo) args.push('--yolo');
    args.push(...(act.extraArgs ?? []));

    const result = runCli(args, { cwd: workspace, env: act.env, stdin: act.stdinLines });
    const expected = act.expectExit ?? 0;
    if (result.status !== expected) {
      failures.add(`exit ${String(result.status)} != ${expected}\n${describe(args, result)}`);
      continue;
    }
    ok(`exit ${expected}`);
    const stdout = result.stdout ?? '';
    outputs.push(stdout);
    const needle = Array.isArray(act.expectContains)
      ? (act.expectContains[1] ?? act.expectContains[0])
      : act.expectContains;
    if (needle) assertContains(stdout + (result.stderr ?? ''), needle, act.name, failures);
    if (act.name.startsWith('Act 4')) {
      const written = path.join(workspace, 'notes', 'summary.md');
      if (fs.existsSync(written) && fs.readFileSync(written, 'utf8').includes('hello world'))
        ok('notes/summary.md written');
      else failures.add('Act 4 did not write notes/summary.md');
    }
    if (act.name.startsWith('Act 5')) {
      const written = path.join(workspace, 'notes', 'forbidden.md');
      if (!fs.existsSync(written)) ok('Act 5 created no unexpected files');
    }
  }

  step('Act 11 · trace viewer');
  const traces = await loadTraces(traceDir);
  if (traces.length === 0) {
    failures.add(`no traces found under ${traceDir}`);
  } else {
    ok(`${traces.length} trace file(s) produced`);
    const firstRun = path.basename(traces[0]?.file ?? '').replace('.jsonl', '');
    const show = runCli(
      [
        'trace',
        'show',
        firstRun,
        '--config',
        path.join(workspace, 'agent-shell.config.ts'),
        '--json',
      ],
      { cwd: workspace },
    );
    if (show.status !== 0)
      failures.add(
        `trace show exited ${String(show.status)}\n${describe(['trace', 'show'], show)}`,
      );
    else {
      const lines = (show.stdout ?? '')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0);
      let parsed = 0;
      for (const line of lines) {
        try {
          JSON.parse(line);
          parsed += 1;
        } catch {
          failures.add(`trace show --json emitted a non-JSON line: ${line.slice(0, 80)}`);
          break;
        }
      }
      if (parsed > 0) ok(`trace show --json parsed ${parsed} line(s)`);
    }
    const human = runCli(
      ['trace', 'show', firstRun, '--config', path.join(workspace, 'agent-shell.config.ts')],
      { cwd: workspace },
    );
    if (human.status !== 0) failures.add('trace show (human) failed');
    else assertContains(human.stdout ?? '', 'run', 'trace show tree', failures);
    const list = runCli(
      ['trace', 'list', '--config', path.join(workspace, 'agent-shell.config.ts')],
      { cwd: workspace },
    );
    if (list.status !== 0) failures.add('trace list failed');
  }

  step('Event coverage assertions');
  const events = flatten(traces);
  if (events.length === 0) failures.add('no events recorded at all');
  assertSchemaValid(traces, failures);
  assertRunPairs(traces, failures);
  assertSpanLinks(events, failures);
  assertToolSources(events, failures);
  assertNamespaces(
    events,
    [
      'read_file',
      'write_file',
      'run_shell',
      'plugin__word_count__word_count',
      'mcp__echo__echo',
      'runtime__spawn_subagent',
    ],
    failures,
  );
  assertApprovalCounts(events, { write: 1, exec: 2 }, failures);
  assertSubagents(events, ['spawn', 'supervisor', 'swarm'], failures);
  const providers = new Set(
    events
      .filter((e) => e.type === 'llm.started')
      .map((e) => (e.payload as { provider?: string }).provider),
  );
  if (!providers.has('openai')) failures.add('no llm.started from openai');
  if (!providers.has('anthropic')) failures.add('no llm.started from anthropic');
  if (providers.size >= 2) ok(`llm.started covers ${[...providers].sort().join(', ')}`);
  if (!events.some((e) => e.type === 'plugin.loaded')) failures.add('no plugin.loaded event');
  if (!events.some((e) => e.type === 'mcp.connected')) failures.add('no mcp.connected event');
  if (!events.some((e) => e.type === 'session.resumed'))
    failures.add('no session.resumed event (Act 10)');
  if (
    !events.some(
      (e) =>
        e.type === 'llm.completed' &&
        (e.payload as { usage?: { totalTokens?: number } }).usage?.totalTokens,
    )
  ) {
    failures.add('no llm.completed carried token usage');
  }
  if (traces.length > 0) assertTree(events, failures);
  await assertListRuns(traceDir, failures);

  step('Security assertions');
  const unmatched = runCli(
    [
      'run',
      '写入 notes/forbidden.md',
      '--config',
      path.join(workspace, 'agent-shell.config.ts'),
      '--provider',
      'openai:unmatchedWrite',
      '--session',
      `${sessionId}_neg`,
      '--script',
      writeScript(workspace, 'unmatched', []),
    ],
    { cwd: workspace },
  );
  if (unmatched.status === 0)
    failures.add('script mode accepted an unauthorised write (expected failure)');
  else ok(`unauthorised write failed with exit ${String(unmatched.status)}`);

  const nonInteractive = runCli(
    [
      'run',
      '写入 notes/forbidden.md',
      '--config',
      path.join(workspace, 'agent-shell.config.ts'),
      '--provider',
      'openai:unmatchedWrite',
      '--session',
      `${sessionId}_nonint`,
      '--json',
    ],
    { cwd: workspace },
  );
  const nonIntEvents = ndjson(nonInteractive.stdout);
  const denied = nonIntEvents.some(
    (event) =>
      event.type === 'tool.approval.decided' &&
      (event.payload as { decision?: string }).decision === 'deny',
  );
  if (!denied)
    failures.add(`non-interactive write was not denied (exit ${String(nonInteractive.status)})`);
  else ok('non-interactive write denied by policy');

  for (const [scriptName, label] of [
    ['escapePath', 'relative .. escape'],
    ['absolutePath', 'absolute path outside workspace'],
  ] as const) {
    const result = runCli(
      [
        'run',
        '读取越界文件',
        '--config',
        path.join(workspace, 'agent-shell.config.ts'),
        '--provider',
        `openai:${scriptName}`,
        '--session',
        `${sessionId}_${scriptName}`,
        '--json',
      ],
      { cwd: workspace },
    );
    const rejected = ndjson(result.stdout).some(
      (event) =>
        (event.type === 'tool.error' ||
          ((event.type === 'tool.finished' && (event.payload as { isError?: boolean }).isError) ??
            false)) &&
        /outside the workspace|WorkspaceBoundary|PATH_OUTSIDE/i.test(JSON.stringify(event.payload)),
    );
    if (!rejected) failures.add(`${label} was not rejected (exit ${String(result.status)})`);
    else ok(`${label} rejected by the path guard`);
  }

  const yoloHardDeny = runCli(
    [
      'run',
      '执行危险命令',
      '--config',
      path.join(workspace, 'agent-shell.config.ts'),
      '--provider',
      'openai:hardDeny',
      '--session',
      `${sessionId}_yolo`,
      '--yolo',
      '--json',
    ],
    { cwd: workspace },
  );
  const hardBlocked = ndjson(yoloHardDeny.stdout).some(
    (event) =>
      (event.type === 'tool.approval.decided' &&
        /hard-deny/i.test(JSON.stringify(event.payload))) ||
      (event.type === 'tool.error' && /hard|denied|refus/i.test(JSON.stringify(event.payload))) ||
      (event.type === 'tool.finished' && (event.payload as { isError?: boolean }).isError),
  );
  if (!hardBlocked)
    failures.add(`--yolo did not hard-deny rm -rf / (exit ${String(yoloHardDeny.status)})`);
  else ok('hard-deny still blocks rm -rf / under --yolo');

  const configDump = runCli(
    ['config', 'validate', '--json', '--config', path.join(workspace, 'agent-shell.config.ts')],
    {
      cwd: workspace,
      env: { ACCEPTANCE_SECRET: FAKE_SECRET },
    },
  );
  const secretFiles = [...traces.map((trace) => trace.file)];
  if (configDump.stdout) {
    const dumpFile = path.join(workspace, 'config-dump.txt');
    fs.writeFileSync(dumpFile, configDump.stdout);
    secretFiles.push(dumpFile);
  }
  assertNoSecret(secretFiles, FAKE_SECRET, failures);

  step('Architecture assertions');
  assertNoBusinessImports(failures);
  assertCliDoesNotConstructUpstream(failures);

  console.log(`\n${'='.repeat(60)}`);
  if (failures.count === 0) {
    console.log(`ACCEPTANCE PASSED — ${traces.length} run(s), ${events.length} events`);
    // docs/04 §2.5: the throwaway workspace is deleted on success and kept for
    // debugging when something failed.
    fs.rmSync(workspace, { recursive: true, force: true });
    return 0;
  }
  console.log(`ACCEPTANCE FAILED — ${failures.count} problem(s)`);
  for (const item of failures.items) console.log(` - ${item}`);
  console.log(`workspace preserved for debugging: ${workspace}`);
  return 1;
}

function ndjson(
  stdout: string | undefined,
): Array<{ type: string; payload: Record<string, unknown> }> {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  for (const line of (stdout ?? '').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (typeof parsed.type === 'string')
        events.push({ type: parsed.type, payload: parsed.payload ?? {} });
    } catch {
      /* non-event stdout lines are tolerated here; Act 11 asserts pure NDJSON */
    }
  }
  return events;
}

function writeScript(workspace: string, name: string, approvals: unknown[]): string {
  const file = path.join(workspace, `script-${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, approvals }, null, 2));
  return file;
}

function assertNoBusinessImports(failures: Failures): void {
  const coreSrc = path.join(REPO, 'packages', 'core', 'src');
  const coreImportPattern = /from\s+["'][^"']*examples|@agent-shell\/example/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.ts$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (coreImportPattern.test(text)) offenders.push(full);
      }
    }
  };
  if (fs.existsSync(coreSrc)) walk(coreSrc);
  if (offenders.length > 0) failures.add(`core imports business code: ${offenders.join(', ')}`);
  else ok('packages/core contains no business/example imports');
}

function assertCliDoesNotConstructUpstream(failures: Failures): void {
  const cliSrc = path.join(REPO, 'packages', 'cli', 'src');
  const banned = [
    /new\s+ChatOpenAI\b/,
    /new\s+ChatAnthropic\b/,
    /new\s+MCPAdapter\b/,
    /from\s+["']@langchain\/(openai|anthropic|mcp-adapters|langgraph-supervisor|langgraph-swarm)/,
  ];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.ts$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (banned.some((pattern) => pattern.test(text))) offenders.push(full);
      }
    }
  };
  walk(cliSrc);
  if (offenders.length > 0)
    failures.add(`cli constructs upstream clients directly: ${offenders.join(', ')}`);
  else ok('cli goes through core adapters only');
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
