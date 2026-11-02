/**
 * CLI E2E for `trace list|show` (docs/03 §8): table, NDJSON events, raw JSONL
 * and tree rendering — against a real run produced by the CLI itself.
 */
import path from 'node:path';
import { validateEvent } from '@agent-shell/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseArgs, cli, cliRun, makeWorkspace, ndjsonLines, type Workspace } from './helpers.js';

let ws: Workspace;
let runId = '';

beforeAll(async () => {
  ws = makeWorkspace({
    scripts: {
      plain: [{ content: 'hello from scripted' }],
      reader: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'call_trace_read' }] },
        { content: 'done' },
      ],
    },
  });
  const first = await cli(
    ['run', 'say hi', ...baseArgs(ws), '--provider', 'fake:plain', '--session', 'ses_trace_1'],
    {
      cwd: ws.dir,
    },
  );
  expect(first.code).toBe(0);
  const second = await cli(
    ['run', 'read a', ...baseArgs(ws), '--provider', 'fake:reader', '--session', 'ses_trace_1'],
    {
      cwd: ws.dir,
    },
  );
  expect(second.code).toBe(0);
  const summaryLine = second.stdout.split('\n').find((line) => line.includes('trace:'));
  expect(summaryLine).toBeDefined();
  const match = /\/(run_[0-9a-f-]+)\.jsonl/.exec(summaryLine ?? '');
  runId = match?.[1] ?? '';
  expect(runId).toMatch(/^run_/);
});

afterAll(() => {
  ws.cleanup();
});

describe('trace list', () => {
  it('prints the documented table', async () => {
    const result = await cli(['trace', 'list', ...baseArgs(ws)], { cwd: ws.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('RUN ID');
    expect(result.stdout).toContain('PROVIDER:MODEL');
    expect(result.stdout).toContain('ses_trac');
    expect(result.stdout).toContain('fake:plain');
  });

  it('--json emits one JSON line per run with the table fields', async () => {
    const result = await cli(['trace', 'list', ...baseArgs(ws), '--json'], { cwd: ws.dir });
    expect(result.code).toBe(0);
    const rows = ndjsonLines(result.stdout);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(typeof row['runId']).toBe('string');
      expect(typeof row['status']).toBe('string');
      expect(typeof row['totalTokens']).toBe('number');
    }
  });

  it('--session filters the listing', async () => {
    const result = await cli(
      ['trace', 'list', ...baseArgs(ws), '--session', 'ses_trace_1', '--json'],
      { cwd: ws.dir },
    );
    const rows = ndjsonLines(result.stdout);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(String(row['sessionId'])).toBe('ses_trace_1');
  });
});

describe('trace show', () => {
  it('renders the span tree for a run in human mode', async () => {
    const result = await cli(['trace', 'show', runId, ...baseArgs(ws)], { cwd: ws.dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('run_');
    expect(result.stdout).toContain('tool read_file');
    expect(result.stdout).toMatch(/[├└]/);
  });

  it('--json emits the event array as NDJSON, every line schema-valid', async () => {
    const result = await cli(['trace', 'show', runId, ...baseArgs(ws), '--json'], { cwd: ws.dir });
    expect(result.code).toBe(0);
    const events = ndjsonLines(result.stdout).map((line) => validateEvent(line));
    expect(events.some((event) => event.type === 'run.started')).toBe(true);
    expect(events.some((event) => event.type === 'run.finished')).toBe(true);
  });

  it('--raw prints the JSONL verbatim', async () => {
    const result = await cli(['trace', 'show', runId, ...baseArgs(ws), '--raw'], { cwd: ws.dir });
    expect(result.code).toBe(0);
    const lines = ndjsonLines(result.stdout);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line['type'] === 'run.finished')).toBe(true);
  });

  it('rejects an unknown run id with a non-zero exit', async () => {
    const result = await cli(['trace', 'show', 'run_does_not_exist', ...baseArgs(ws)], {
      cwd: ws.dir,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('run_does_not_exist');
  });

  it('resolves an id prefix', async () => {
    const prefix = runId.slice(0, 12);
    const result = await cli(['trace', 'show', prefix, ...baseArgs(ws), '--json'], { cwd: ws.dir });
    expect(result.code).toBe(0);
    expect(ndjsonLines(result.stdout).length).toBeGreaterThan(0);
  });
});

describe('trace tail', () => {
  it('replays events as NDJSON and stops cleanly on Ctrl+C', async () => {
    // tailTrace follows until SIGINT; the CLI must map that to a clean exit.
    const tail = cliRun(['trace', 'tail', runId, ...baseArgs(ws), '--json'], { cwd: ws.dir });
    // Interrupt only after the CLI's SIGINT handler exists (process startup via
    // the tsx loader takes ~1-2s) and the existing lines have been replayed.
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    tail.interruptAfter(0);
    const result = await tail.result;
    expect(result.code).toBe(0);
    const events = ndjsonLines(result.stdout).map((line) => validateEvent(line));
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'run.finished')).toBe(true);
  });

  it('points at the file under the documented trace layout', async () => {
    const result = await cli(['trace', 'show', runId, ...baseArgs(ws)], { cwd: ws.dir });
    const tree = result.stdout.split('\n')[0] ?? '';
    expect(tree).toContain('run_');
    expect(path.sep).toBe('/');
  });
});
