#!/usr/bin/env node
/**
 * Minimal stdio MCP server for the file-agent acceptance scenario
 * (docs/04-testing-and-acceptance.md §2.3, §4.1 Act 3).
 *
 * It exists to prove the MCP boundary, not to be useful:
 *  - `echo` carries `annotations.readOnlyHint`, so the adapter may downgrade it
 *    to risk `read`;
 *  - `write_note` carries no annotation, so it keeps the untrusted default of
 *    risk `exec` and must be approved (docs/01 §5.4);
 *  - `--crash-on-call` makes the process die on the first tool call, which is
 *    how the adapter's crash path gets covered;
 *  - `--slow <ms>` stalls a call so the timeout path gets covered.
 *
 * stdout is reserved for JSON-RPC frames: every diagnostic line goes to stderr.
 */
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVER_NAME = 'echo';
const SERVER_VERSION = '1.0.0';

const USAGE = `agent-shell example MCP server (${SERVER_NAME} v${SERVER_VERSION})

Usage: node server.mjs [flags]

Flags:
  --crash-on-call   exit(1) on the first tools/call (exercises the adapter crash path)
  --slow <ms>       delay every tool call by <ms> (exercises the timeout path)
  --help            print this message and exit 0

Tools:
  echo(text)                 readOnlyHint=true   -> risk "read"
  write_note(name,content)   no annotation       -> risk "exec"

Environment:
  MCP_TEST_DIR               directory that write_note may create files in
`;

function parseArgs(argv) {
  const options = { crashOnCall: false, slowMs: 0, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--crash-on-call') {
      options.crashOnCall = true;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--slow') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0) {
        log(
          `--slow expects a non-negative number of milliseconds, received ${String(argv[index + 1])}`,
        );
        process.exit(2);
      }
      index += 1;
      options.slowMs = Math.trunc(value);
      continue;
    }
    log(`ignoring unknown argument "${String(flag)}"`);
  }
  return options;
}

/**
 * Diagnostics only ever go to stderr, never to the protocol stream. Globals are
 * reached through `globalThis` because the shared eslint config declares no Node
 * globals for `.mjs` files, and this Node build has no `node:globalThis` module.
 */
function log(message, fields) {
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
  globalThis.console.error(`[mcp-echo] ${message}${suffix}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

let toolCallsSeen = 0;

function beforeToolCall(toolName, args) {
  toolCallsSeen += 1;
  log(`tools/call ${toolName}`, { args: redact(args) });
  if (options.crashOnCall) {
    log(`--crash-on-call: exiting 1 on call ${String(toolCallsSeen)}`);
    process.exit(1);
  }
}

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = typeof item === 'string' && item.length > 120 ? `${item.slice(0, 120)}…` : item;
  }
  return out;
}

function textResult(text, extra) {
  return {
    content: [{ type: 'text', text }],
    ...(extra === undefined ? {} : { ...extra }),
  };
}

function errorResult(text) {
  return { ...textResult(text), isError: true };
}

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { instructions: 'Echo server for the agent-shell acceptance scenario.' },
);

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Return the given text unchanged. Read-only.',
    inputSchema: { text: z.string().min(1).describe('Text to echo back.') },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  async ({ text }) => {
    beforeToolCall('echo', { text });
    await delay(options.slowMs);
    return textResult(text);
  },
);

server.registerTool(
  'write_note',
  {
    title: 'Write note',
    description: 'Write a note into the directory named by MCP_TEST_DIR.',
    inputSchema: {
      name: z.string().min(1).describe('Note file name; directory parts are stripped.'),
      content: z.string().describe('Note contents.'),
    },
    // No `annotations.readOnlyHint`: this tool keeps the untrusted MCP default of
    // risk `exec`, so the shell must ask for two confirmations.
  },
  async ({ name, content }) => {
    beforeToolCall('write_note', { name, content });
    await delay(options.slowMs);
    const dir = process.env['MCP_TEST_DIR'];
    if (dir === undefined || dir.length === 0) {
      return errorResult('write_note: MCP_TEST_DIR is not set, refusing to write anywhere');
    }
    // Only a basename is ever combined with the allowed directory.
    const safeName = path.basename(name);
    if (safeName.length === 0 || safeName === '.' || safeName === '..') {
      return errorResult(`write_note: invalid note name "${name}"`);
    }
    const target = path.join(dir, safeName);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(target, content, 'utf8');
    } catch (cause) {
      return errorResult(`write_note: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return textResult(`wrote ${target}`);
  },
);

async function shutdown(reason, exitCode) {
  log(`shutting down (${reason})`);
  try {
    await server.close();
  } catch (cause) {
    log(`close failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  process.exit(exitCode);
}

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
} catch (cause) {
  log(`failed to connect: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
log(`ready`, { crashOnCall: options.crashOnCall, slowMs: options.slowMs, pid: process.pid });

// The stdio transport pauses rather than exits when its readable ends, so an
// orphaned server would linger: close the session and leave when stdin ends.
process.stdin.once('end', () => void shutdown('stdin end', 0));
process.stdin.once('close', () => void shutdown('stdin close', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
