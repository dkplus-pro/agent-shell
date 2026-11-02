/**
 * CLI E2E for scripted mode (`--script`, docs/03 §5): no TTY, approvals from
 * the script, unmatched write/exec must fail the script, assertions for
 * `expect.contains` / `exitCode`, and argsMatch/occurrence consumption.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_CODES, validateEvent } from '@agent-shell/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseArgs, cli, makeWorkspace, ndjsonLines, type Workspace } from './helpers.js';

let ws: Workspace;

function writeScript(name: string, body: unknown): string {
  const file = path.join(ws.dir, `script-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

beforeAll(() => {
  ws = makeWorkspace({
    scripts: {
      writer: [
        {
          toolCalls: [
            {
              name: 'write_file',
              args: { path: 'notes/approved.md', content: 'yes' },
              id: 'call_w',
            },
          ],
        },
        { content: 'file written' },
      ],
      shell: [
        { toolCalls: [{ name: 'run_shell', args: { command: 'echo hello' }, id: 'call_e' }] },
        { content: 'shell said hello' },
      ],
      doubleWrite: [
        {
          toolCalls: [
            { name: 'write_file', args: { path: 'notes/first.md', content: '1' }, id: 'call_1' },
            { name: 'write_file', args: { path: 'notes/second.md', content: '2' }, id: 'call_2' },
          ],
        },
        { content: 'two writes' },
      ],
      forbidden: [
        {
          toolCalls: [
            {
              name: 'write_file',
              args: { path: 'notes/forbidden.md', content: 'no' },
              id: 'call_f',
            },
          ],
        },
        { content: 'write was refused' },
      ],
      plainturn: [{ content: 'turn one complete', usage: { inputTokens: 10, outputTokens: 5 } }],
    },
  });
});

afterAll(() => {
  ws.cleanup();
});

describe('scripted approvals — deterministic without a TTY', () => {
  it('approves a write from the script and the tool actually runs', async () => {
    const script = writeScript('approve-write', {
      version: 1,
      provider: 'fake:writer',
      approvals: [{ tool: 'write_file', decision: 'approve' }],
    });
    const result = await cli(
      ['run', 'write notes/approved.md', ...baseArgs(ws), '--script', script],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('file written');
    expect(fs.readFileSync(path.join(ws.dir, 'notes', 'approved.md'), 'utf8')).toBe('yes');
  });

  it("consumes exec approvals in two steps when confirmation is 'run'", async () => {
    const script = writeScript('approve-exec', {
      version: 1,
      provider: 'fake:shell',
      approvals: [{ tool: 'run_shell', decision: 'approve', confirmation: 'run' }],
    });
    const result = await cli(
      [
        'run',
        'echo hello',
        ...baseArgs(ws),
        '--script',
        script,
        '--json',
        '--session',
        'ses_script_exec',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(0);
    const events = ndjsonLines(result.stdout).map((line) => validateEvent(line));
    const decided = events.filter((event) => event.type === 'tool.approval.decided');
    expect(decided.length).toBeGreaterThanOrEqual(2); // attempt 1 + attempt 2
    expect(decided.some((event) => event.payload['confirmation'] === 'run')).toBe(true);
    expect(decided.every((event) => event.payload['decision'] === 'approve')).toBe(true);
    // stdout is NDJSON only; the answer text travels in the llm.completed event.
    const llmDone = events.find(
      (event) =>
        event.type === 'llm.completed' &&
        JSON.stringify(event.payload['outputPreview']).includes('shell said hello'),
    );
    expect(llmDone).toBeDefined();
    expect(
      result.stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .every((line) => line.trimStart().startsWith('{')),
    ).toBe(true);
  });

  it('argsMatch and occurrence select rules in declaration order', async () => {
    const script = writeScript('occurrence', {
      version: 1,
      provider: 'fake:doubleWrite',
      approvals: [
        {
          tool: 'write_file',
          decision: 'deny',
          argsMatch: { path: 'notes/first.md' },
          occurrence: 1,
        },
        {
          tool: 'write_file',
          decision: 'approve',
          argsMatch: { path: 'notes/second.md' },
          occurrence: 2,
        },
      ],
    });
    const result = await cli(
      ['run', 'two writes', ...baseArgs(ws), '--script', script, '--session', 'ses_script_occ'],
      {
        cwd: ws.dir,
      },
    );
    expect(result.code).toBe(0); // matched deny rules do not fail the script
    expect(fs.existsSync(path.join(ws.dir, 'notes', 'first.md'))).toBe(false);
    expect(fs.readFileSync(path.join(ws.dir, 'notes', 'second.md'), 'utf8')).toBe('2');
  });

  it('an unmatched write is denied AND fails the script (docs/03 §5)', async () => {
    const script = writeScript('empty', { version: 1, provider: 'fake:forbidden', approvals: [] });
    const result = await cli(
      [
        'run',
        'write forbidden',
        ...baseArgs(ws),
        '--script',
        script,
        '--session',
        'ses_script_unmatched',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(EXIT_CODES.approvalDenied);
    expect(result.stderr).toContain('unmatched approval request');
    expect(fs.existsSync(path.join(ws.dir, 'notes', 'forbidden.md'))).toBe(false);
  });

  it("exec approve without confirmation 'run' fails the script", async () => {
    const script = writeScript('exec-no-run', {
      version: 1,
      provider: 'fake:shell',
      approvals: [{ tool: 'run_shell', decision: 'approve' }],
    });
    const result = await cli(
      [
        'run',
        'echo hello',
        ...baseArgs(ws),
        '--script',
        script,
        '--session',
        'ses_script_execfail',
      ],
      {
        cwd: ws.dir,
      },
    );
    expect(result.code).toBe(EXIT_CODES.approvalDenied);
    expect(result.stderr).toContain('run');
  });

  it('turns[] with expect.contains pass and fail assertions; exitCode is asserted', async () => {
    const pass = writeScript('turns-pass', {
      version: 1,
      provider: 'fake:plainturn',
      turns: [{ input: 'hi', expect: { contains: 'turn one', exitCode: 0 } }],
      approvals: [],
    });
    const passResult = await cli(['run', 'ignored', ...baseArgs(ws), '--script', pass], {
      cwd: ws.dir,
    });
    expect(passResult.code).toBe(0);

    const fail = writeScript('turns-fail', {
      version: 1,
      provider: 'fake:plainturn',
      turns: [{ input: 'hi', expect: { contains: 'this text never appears' } }],
      approvals: [],
    });
    const failResult = await cli(['run', 'ignored', ...baseArgs(ws), '--script', fail], {
      cwd: ws.dir,
    });
    expect(failResult.code).not.toBe(0);
    expect(failResult.stderr).toContain('this text never appears');
  });

  it('an invalid script fails with a config error (exit 2)', async () => {
    const bad = writeScript('bad', { version: 2, approvals: [] });
    const result = await cli(['run', 'anything', ...baseArgs(ws), '--script', bad], {
      cwd: ws.dir,
    });
    expect(result.code).toBe(EXIT_CODES.config);
    expect(result.stderr).toContain('script');
  });
});
