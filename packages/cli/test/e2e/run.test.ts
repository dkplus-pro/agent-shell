/**
 * CLI E2E for `run` (docs/04 §3.4): human/JSON/quiet output, tool cards,
 * non-interactive denial and the chat REPL smoke. No TTY, no network: scripted
 * providers only (docs/04 §1 hard rules).
 */
import fs from 'node:fs';
import path from 'node:path';
import { validateEvent } from '@agent-shell/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  baseArgs,
  cli,
  makeWorkspace,
  ndjsonLines,
  traceFiles,
  type Workspace,
} from './helpers.js';

let ws: Workspace;

beforeAll(() => {
  ws = makeWorkspace({
    scripts: {
      plain: [{ content: 'hello from scripted' }],
      reader: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'call_read' }] },
        { content: 'a.md says hello world' },
      ],
      writer: [
        {
          toolCalls: [
            { name: 'write_file', args: { path: 'notes/x.md', content: 'no' }, id: 'call_write' },
          ],
        },
        { content: 'write refused' },
      ],
      hardDeny: [
        { toolCalls: [{ name: 'run_shell', args: { command: 'rm -rf /' }, id: 'call_hd' }] },
        { content: 'destructive command blocked' },
      ],
    },
  });
});

afterEach(() => {
  fs.rmSync(path.join(ws.dir, 'notes', 'x.md'), { force: true });
});

afterAll(() => {
  ws.cleanup();
});

describe('run — human output', () => {
  it('streams the answer, prints the run summary and writes a trace file', async () => {
    const result = await cli(
      ['run', 'say hi', ...baseArgs(ws), '--provider', 'fake:plain', '--session', 'ses_run_human'],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('hello from scripted');
    expect(result.stdout).toContain('steps=');
    expect(result.stdout).toMatch(/trace: .*\.jsonl/);
    const files = traceFiles(ws);
    expect(files.some((file) => file.includes(`${path.sep}ses_run_human${path.sep}`))).toBe(true);
  });

  it('renders tool cards on stderr (progress), answer on stdout', async () => {
    const result = await cli(
      [
        'run',
        'read notes/a.md',
        ...baseArgs(ws),
        '--provider',
        'fake:reader',
        '--session',
        'ses_run_card',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('→ tool read_file');
    expect(result.stderr).toContain('← ok');
    expect(result.stdout).toContain('hello world');
  });
});

describe('run — machine output', () => {
  it('--json emits NDJSON of schema-valid AgentEvents on stdout only', async () => {
    const result = await cli(
      [
        'run',
        'read notes/a.md',
        ...baseArgs(ws),
        '--provider',
        'fake:reader',
        '--session',
        'ses_run_json',
        '--json',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0);
    const events = ndjsonLines(result.stdout).map((line) => validateEvent(line));
    const types = new Set(events.map((event) => event.type));
    expect(types.has('run.started')).toBe(true);
    expect(types.has('llm.completed')).toBe(true);
    expect(types.has('tool.started')).toBe(true);
    expect(types.has('tool.finished')).toBe(true);
    expect(types.has('run.finished')).toBe(true);
    const finished = events.find((event) => event.type === 'run.finished');
    expect(finished?.payload['status']).toBe('ok');
    // stdout must carry no decorations: every non-empty line parsed above.
    expect(result.stdout).not.toMatch(/[→←⚠]/);
  });

  it('--quiet prints exactly the final answer', async () => {
    const result = await cli(
      [
        'run',
        'say hi',
        ...baseArgs(ws),
        '--provider',
        'fake:plain',
        '--session',
        'ses_run_quiet',
        '--quiet',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hello from scripted');
    expect(result.stdout).not.toContain('steps=');
  });
});

describe('run — approval policy without a TTY', () => {
  it('denies write for non-interactive runs with reason non-interactive', async () => {
    const result = await cli(
      [
        'run',
        'write notes/x.md',
        ...baseArgs(ws),
        '--provider',
        'fake:writer',
        '--session',
        'ses_run_deny',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0); // the model continues after a denial (docs/03 §10)
    expect(result.stdout).toContain('write refused');
    expect(fs.existsSync(path.join(ws.dir, 'notes', 'x.md'))).toBe(false);
    const denial = ndjsonLinesFromTraces(ws).find(
      (event) => event.type === 'tool.approval.decided' && event.payload['decision'] === 'deny',
    );
    expect(denial).toBeDefined();
    expect(String(denial?.payload['reason'])).toContain('non-interactive');
  });

  it('--yolo skips write prompts but the hard-deny net still blocks rm -rf /', async () => {
    const yoloWrite = await cli(
      [
        'run',
        'write notes/x.md',
        ...baseArgs(ws),
        '--provider',
        'fake:writer',
        '--session',
        'ses_run_yolo',
        '--yolo',
      ],
      { cwd: ws.dir },
    );
    expect(yoloWrite.code).toBe(0);
    expect(fs.existsSync(path.join(ws.dir, 'notes', 'x.md'))).toBe(true);

    const yoloDanger = await cli(
      [
        'run',
        'do something dangerous',
        ...baseArgs(ws),
        '--provider',
        'fake:hardDeny',
        '--session',
        'ses_run_harddeny',
        '--yolo',
      ],
      { cwd: ws.dir },
    );
    expect(yoloDanger.code).toBe(0);
    const events = ndjsonLinesFromTraces(ws);
    const blocked = events.some(
      (event) =>
        event.type === 'tool.approval.decided' && /hard-deny/.test(JSON.stringify(event.payload)),
    );
    expect(blocked).toBe(true);
  });
});

describe('chat — REPL smoke', () => {
  it('enters the REPL and exits on /quit (piped stdin, no TTY)', async () => {
    const result = await cli(['chat', ...baseArgs(ws), '--provider', 'fake:plain'], {
      cwd: ws.dir,
      stdin: '/help\n/quit\n',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('/trace');
  });
});

function ndjsonLinesFromTraces(
  workspace: Workspace,
): { type: string; payload: Record<string, unknown> }[] {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  for (const file of traceFiles(workspace)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as { type: string; payload: Record<string, unknown> };
      events.push(parsed);
    }
  }
  return events;
}
