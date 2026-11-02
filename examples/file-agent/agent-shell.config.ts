/**
 * Composition root for the one reference scenario in this repo
 * (docs/00-requirements.md FR-13, docs/04-testing-and-acceptance.md §4.1).
 *
 * This file is where the business tools live: `packages/core` stays
 * business-free (AGENT.md §2), so `read_file` / `write_file` / `run_shell` are
 * registered here with `defineTool()` rather than inside the runtime.
 *
 * The relative entries below (`./plugins`, `./model.script.json`,
 * `./mcp-echo-server/server.mjs`) are meant to resolve against this file's
 * directory, which is also where `trace.dataDir` lands. `workspaceRoot` is the
 * documented exception: `resolveRuntimePaths()` resolves it against the process
 * cwd, so the acceptance runner passes `--workspace <tmp>` instead. Secrets are
 * env references only — these scripted providers need no key at all, and a real
 * `openai` / `anthropic` entry must use `apiKey: env("OPENAI_API_KEY")`.
 */
import type { RawConfig } from '../../packages/core/src/config/schema.js';
import { readFileTool } from './tools/read-file.js';
import { runShellTool } from './tools/run-shell.js';
import { writeFileTool } from './tools/write-file.js';

export default {
  providers: {
    // Provider ids are the config keys; `openai:fake` / `anthropic:fake` are the
    // `provider:model` references the CLI uses (docs/03 §1).
    openai: {
      kind: 'scripted',
      script: './model.script.json',
      models: ['fake'],
      capabilities: { streaming: true, toolCalling: true, contextWindow: 32_000 },
    },
    anthropic: {
      kind: 'scripted',
      script: './model.script.json',
      models: ['fake'],
      capabilities: { streaming: true, toolCalling: true, contextWindow: 32_000 },
    },
  },

  defaults: {
    provider: 'openai:fake',
    preset: 'single',
    agent: 'default',
  },

  // Standalone default; the acceptance runner overrides it with `--workspace`.
  workspaceRoot: './workspace',

  tools: {
    code: [readFileTool, writeFileTool, runShellTool],
  },

  plugins: {
    enabled: true,
    dirs: ['./plugins'],
  },

  mcp: {
    servers: {
      echo: {
        transport: 'stdio',
        command: 'node',
        args: ['./mcp-echo-server/server.mjs'],
        // Names only; values stay in the environment (docs/01 §5.4).
        envVars: ['MCP_TEST_DIR'],
        timeoutMs: 30_000,
        // No overrides: `echo` downgrades to `read` via its readOnlyHint and
        // `write_note` keeps the untrusted default of `exec`.
        riskOverrides: {},
      },
    },
  },

  agents: {
    default: {
      name: 'default',
      prompt:
        'You are the file-agent reference assistant. Read files before answering, ' +
        'use the word-count plugin and the echo MCP server when they help, and keep ' +
        'your final answer short.',
      // An empty allowlist means "every registered tool" — Acts 2 and 3 of the
      // acceptance scenario need the plugin and MCP tools, and `agents.*.tools`
      // may only name code tools (config validation rejects namespaced names).
      tools: [],
    },
    researcher: {
      name: 'researcher',
      prompt:
        'You are a researcher. You may only read. Report one factual sentence about ' +
        'what the file contained and nothing else.',
      tools: ['read_file'],
      limits: { maxSteps: 6 },
    },
    writer: {
      name: 'writer',
      prompt:
        'You are a writer. Read what you need, then write the requested file inside ' +
        'the workspace. Confirm the path you wrote.',
      tools: ['read_file', 'write_file'],
      limits: { maxSteps: 8 },
    },
    lead: {
      name: 'lead',
      prompt:
        'You are the supervisor of a small team. Delegate reading to `researcher` and ' +
        'writing to `writer`, then summarise their results.',
      tools: ['read_file'],
      limits: { maxSteps: 10 },
    },
  },

  presets: {
    single: { kind: 'single', agent: 'default' },
    team: {
      kind: 'supervisor',
      supervisor: 'lead',
      agents: ['researcher', 'writer'],
      outputMode: 'full_history',
    },
    swarm: {
      kind: 'swarm',
      agents: ['researcher', 'writer'],
      defaultActiveAgent: 'researcher',
    },
  },

  // Defaults on purpose: write = 1 confirmation, exec = 2, no allowlist bypass,
  // non-interactive denies. The acceptance script supplies the decisions.
  approvals: {},

  limits: {},

  trace: {},

  // Memory checkpointer keeps each acceptance run deterministic and leaves no
  // sqlite file inside the example directory.
  checkpointer: 'memory',
} satisfies RawConfig;
