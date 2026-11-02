/**
 * CLI E2E for exit codes (docs/03 §10). Each code is produced by the scenario
 * it documents; nothing here weakens the mapping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_CODES } from '@agent-shell/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseArgs, cli, cliRun, makeWorkspace, type Workspace } from './helpers.js';

let ws: Workspace;
let budgetWs: Workspace;

beforeAll(() => {
  ws = makeWorkspace({
    scripts: {
      plain: [{ content: 'all good' }],
      providerBoom: [
        { error: { name: 'ProviderError', message: '401 invalid api key', code: 'auth' } },
      ],
      runaway: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r1' }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r2' }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r3' }] },
        { content: 'should never get here' },
      ],
      sleeper: [
        { toolCalls: [{ name: 'sleep_tool', args: { ms: 15000 }, id: 's1' }] },
        { content: 'woke up' },
      ],
      writer: [
        {
          toolCalls: [
            { name: 'write_file', args: { path: 'notes/nope.md', content: 'x' }, id: 'w1' },
          ],
        },
        { content: 'refused' },
      ],
    },
  });
  // Budget needs tight limits without poisoning other scenarios' exit codes
  // (a denied write in a 2-step budget would exit 6, not 5).
  budgetWs = makeWorkspace({
    scripts: {
      runaway: [
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r1' }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r2' }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' }, id: 'r3' }] },
        { content: 'should never get here' },
      ],
    },
    limits: {
      maxSteps: 2,
      tokenBudget: 200000,
      maxWallTimeMs: 60000,
      maxSubagents: 4,
      maxSubagentDepth: 1,
    },
  });
});

afterAll(() => {
  ws.cleanup();
  budgetWs.cleanup();
});

describe('exit code 0', () => {
  it('successful scripted run', async () => {
    const result = await cli(
      ['run', 'hi', ...baseArgs(ws), '--provider', 'fake:plain', '--session', 'ses_x_ok'],
      {
        cwd: ws.dir,
      },
    );
    expect(result.code).toBe(EXIT_CODES.ok);
  });
});

describe('exit code 2 — configuration', () => {
  it('missing config file', async () => {
    const emptyDir = fs.mkdtempSync(path.join(ws.dir, 'empty-'));
    const result = await cli(['run', 'hi', '--config', path.join(emptyDir, 'nope.config.ts')], {
      cwd: emptyDir,
    });
    expect(result.code).toBe(EXIT_CODES.config);
    expect(result.stderr).toContain('not found');
  });

  it('config without providers fails schema validation', async () => {
    const badDir = fs.mkdtempSync(path.join(ws.dir, 'bad-'));
    fs.writeFileSync(
      path.join(badDir, 'agent-shell.config.ts'),
      'export default { providers: {} };\n',
    );
    const result = await cli(
      ['config', 'validate', '--config', path.join(badDir, 'agent-shell.config.ts')],
      {
        cwd: badDir,
      },
    );
    expect(result.code).toBe(EXIT_CODES.config);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('invalid --script JSON fails as configuration error', async () => {
    const file = path.join(ws.dir, 'script-v2.json');
    fs.writeFileSync(file, JSON.stringify({ version: 2, approvals: [] }));
    const result = await cli(['run', 'hi', ...baseArgs(ws), '--script', file], { cwd: ws.dir });
    expect(result.code).toBe(EXIT_CODES.config);
  });
});

describe('exit code 3 — provider errors', () => {
  it('scripted ProviderError maps to 3', async () => {
    const result = await cli(
      [
        'run',
        'boom',
        ...baseArgs(ws),
        '--provider',
        'fake:providerBoom',
        '--session',
        'ses_x_prov',
      ],
      {
        cwd: ws.dir,
      },
    );
    expect(result.code).toBe(EXIT_CODES.provider);
    expect(result.stderr).toContain('invalid api key');
  });

  it('--json still exits 3 while keeping stdout NDJSON-only', async () => {
    const result = await cli(
      [
        'run',
        'boom',
        ...baseArgs(ws),
        '--provider',
        'fake:providerBoom',
        '--session',
        'ses_x_provjson',
        '--json',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(EXIT_CODES.provider);
    for (const line of result.stdout.split('\n').filter((l) => l.trim().length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(result.stdout).toContain('run.error');
  });
});

describe('exit code 5 — approvals', () => {
  it('scripted mode with an unmatched write exits 5', async () => {
    const file = path.join(ws.dir, 'script-empty.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, approvals: [] }));
    const result = await cli(
      [
        'run',
        'write nope',
        ...baseArgs(ws),
        '--provider',
        'fake:writer',
        '--script',
        file,
        '--session',
        'ses_x_deny',
      ],
      { cwd: ws.dir },
    );
    expect(result.code).toBe(EXIT_CODES.approvalDenied);
  });
});

describe('exit code 6 — budget', () => {
  it('exceeding maxSteps exits 6', async () => {
    const result = await cli(
      [
        'run',
        'loop',
        ...baseArgs(budgetWs),
        '--provider',
        'fake:runaway',
        '--session',
        'ses_x_budget',
      ],
      { cwd: budgetWs.dir },
    );
    expect(result.code).toBe(EXIT_CODES.budget);
    expect(result.stderr).toContain('Budget exceeded');
  });
});

describe('exit code 130 — user cancel', () => {
  it('Ctrl+C during a long tool run exits 130', async () => {
    const run = cliRun(
      [
        'run',
        'sleep',
        ...baseArgs(ws),
        '--provider',
        'fake:sleeper',
        '--session',
        'ses_x_cancel',
        '--yolo',
      ],
      { cwd: ws.dir },
    );
    run.interruptAfter(2_500);
    const result = await run.result;
    expect(result.code).toBe(EXIT_CODES.cancelled);
  });
});

describe('exit code 1 — unexpected', () => {
  it('unknown option exits 1 (usage error)', async () => {
    // NOTE: a bare unknown WORD enters the default `chat` command by design
    // (docs/03 §1: chat is the default command), so usage errors are tested
    // via an unknown option, not an unknown subcommand.
    const result = await cli(['run', 'hi', ...baseArgs(ws), '--definitely-not-an-option'], {
      cwd: ws.dir,
    });
    expect(result.code).toBe(EXIT_CODES.unexpected);
  });
});
