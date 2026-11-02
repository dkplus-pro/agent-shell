#!/usr/bin/env node
/**
 * Local stdio MCP server used by the MCP adapter tests
 * (docs/04-testing-and-acceptance.md §2.3).
 *
 * Tools:
 * - `echo`       — declares `annotations.readOnlyHint: true`, so the adapter may
 *                  downgrade it to risk "read".
 * - `write_note` — no annotations at all, so it stays at the untrusted default
 *                  "exec" and writes into `$MCP_TEST_DIR` (fallback `/tmp`).
 *
 * Flags (both exist so crash/timeout paths are testable without a fake SDK):
 * - `--crash-on-call`  exit(1) as soon as any tool request arrives;
 * - `--slow <ms>`      delay this many milliseconds before answering a tool call.
 *
 * Nothing but MCP JSON-RPC may ever be written to stdout; diagnostics go to stderr.
 *
 * `@modelcontextprotocol/sdk` is only linked into the example workspace package, so a
 * plain specifier import is tried first and an absolute-path fallback (workspace root
 * plus the pnpm content store) follows. No dependency is added for this.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const SERVER_SUBPATHS = {
  server: ['server', 'mcp.js'],
  stdio: ['server', 'stdio.js'],
};
const SDK_PACKAGE = ['@modelcontextprotocol', 'sdk'];

function parseArgs(argv) {
  const slowIndex = argv.indexOf('--slow');
  const slowMs = slowIndex === -1 ? 0 : Number.parseInt(argv[slowIndex + 1] ?? '0', 10);
  return {
    crashOnCall: argv.includes('--crash-on-call'),
    slowMs: Number.isFinite(slowMs) && slowMs > 0 ? slowMs : 0,
  };
}

function workspaceRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(fileURLToPath(import.meta.url));
    dir = parent;
  }
}

/** Absolute candidates for `<pkg>/dist/<esm|cjs>/<subpath>`, most specific first. */
function sdkCandidates(subpath) {
  const root = workspaceRoot();
  const packageDirs = [path.join(root, 'node_modules', ...SDK_PACKAGE)];
  const store = path.join(root, 'node_modules', '.pnpm');
  if (fs.existsSync(store)) {
    for (const entry of fs.readdirSync(store)) {
      if (!entry.startsWith(`${SDK_PACKAGE.join('+')}@`)) continue;
      packageDirs.push(path.join(store, entry, 'node_modules', ...SDK_PACKAGE));
    }
  }
  return packageDirs.flatMap((dir) =>
    ['esm', 'cjs'].map((flavour) => path.join(dir, 'dist', flavour, ...subpath)),
  );
}

async function loadSdk(kind) {
  const subpath = SERVER_SUBPATHS[kind];
  const specifier = `${SDK_PACKAGE.join('/')}/${subpath.join('/')}`;
  try {
    return await import(specifier);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    for (const candidate of sdkCandidates(subpath)) {
      if (fs.existsSync(candidate)) return await import(pathToFileURL(candidate).href);
    }
    throw new Error(`Cannot resolve "${specifier}" from ${fileURLToPath(import.meta.url)}`, {
      cause: error,
    });
  }
}

const { McpServer } = await loadSdk('server');
const { StdioServerTransport } = await loadSdk('stdio');

const { crashOnCall, slowMs } = parseArgs(process.argv.slice(2));

/** Simulates an unstable or slow server before any result is produced. */
async function beforeTool(name) {
  process.stderr.write(
    `echo-server: tool call ${name} (crashOnCall=${crashOnCall} slowMs=${slowMs})\n`,
  );
  if (crashOnCall) process.exit(1);
  if (slowMs > 0) await sleep(slowMs);
}

const server = new McpServer({ name: 'agent-shell-echo-test-server', version: '0.0.0' });

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Return the provided text unchanged.',
    inputSchema: { text: z.string().describe('Text to echo back') },
    annotations: { readOnlyHint: true, openWorldHint: false, title: 'Echo' },
  },
  async ({ text }) => {
    await beforeTool('echo');
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'write_note',
  {
    title: 'Write note',
    description: 'Write a note into MCP_TEST_DIR (or /tmp) and return the file path.',
    inputSchema: {
      text: z.string().describe('Note body'),
      name: z.string().min(1).optional().describe('Optional file name'),
    },
  },
  async ({ text, name }) => {
    await beforeTool('write_note');
    const dir = process.env.MCP_TEST_DIR ?? '/tmp';
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, name ?? `note-${Date.now()}.md`);
    await fs.promises.writeFile(file, text, 'utf8');
    return { content: [{ type: 'text', text: file }] };
  },
);

await server.connect(new StdioServerTransport());
process.stderr.write(`echo-server: listening (crashOnCall=${crashOnCall} slowMs=${slowMs})\n`);
