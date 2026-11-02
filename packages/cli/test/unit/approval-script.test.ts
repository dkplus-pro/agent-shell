/**
 * Unit tests for the scripted approval policy (docs/03 §5) — pure logic, no
 * child processes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, type ApprovalRequest } from '@agent-shell/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScriptController,
  argsSubsetMatch,
  loadScriptFile,
  scriptSchema,
} from '../../src/approvals/script.js';

function request(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    approvalId: 'apr_test',
    tool: 'write_file',
    source: 'code',
    risk: 'write',
    argsPreview: {},
    attempt: 1,
    runId: 'run_test',
    spanId: 'spn_test',
    ...overrides,
  };
}

let tmpDir = '';

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-shell-script-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('script schema', () => {
  it('accepts the documented shape', () => {
    const parsed = scriptSchema.safeParse({
      version: 1,
      provider: 'openai:fake',
      preset: 'single',
      turns: [{ input: '读取 notes/a.md', expect: { contains: 'hello' } }],
      approvals: [
        { tool: 'write_file', decision: 'approve' },
        { tool: 'run_shell', decision: 'approve', confirmation: 'run' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects wrong version, unknown keys and bad rules', () => {
    expect(scriptSchema.safeParse({ version: 2, approvals: [] }).success).toBe(false);
    expect(scriptSchema.safeParse({ version: 1, mystery: true }).success).toBe(false);
    expect(
      scriptSchema.safeParse({ version: 1, approvals: [{ tool: 'x', decision: 'maybe' }] }).success,
    ).toBe(false);
    expect(
      scriptSchema.safeParse({
        version: 1,
        approvals: [{ tool: 'x', decision: 'approve', confirmation: 'yes' }],
      }).success,
    ).toBe(false);
  });

  it('loadScriptFile reports config errors for malformed input', () => {
    const badJson = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badJson, '{not json');
    expect(() => loadScriptFile(badJson)).toThrow(ConfigError);

    const badSchema = path.join(tmpDir, 'bad-schema.json');
    fs.writeFileSync(badSchema, JSON.stringify({ version: 3 }));
    expect(() => loadScriptFile(badSchema)).toThrow(ConfigError);

    expect(() => loadScriptFile(path.join(tmpDir, 'missing.json'))).toThrow(ConfigError);
  });
});

describe('args subset match', () => {
  it('matches scalars, nested objects and arrays', () => {
    expect(argsSubsetMatch(undefined, { anything: 1 })).toBe(true);
    expect(argsSubsetMatch({ path: 'a.md' }, { path: 'a.md', content: 'x' })).toBe(true);
    expect(argsSubsetMatch({ path: 'b.md' }, { path: 'a.md' })).toBe(false);
    expect(argsSubsetMatch({ meta: { n: 1 } }, { meta: { n: 1, extra: 2 } })).toBe(true);
    expect(argsSubsetMatch({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toBe(true);
    expect(argsSubsetMatch({ tags: ['a'] }, { tags: ['a', 'b'] })).toBe(false);
  });
});

describe('approval consumption', () => {
  it('consumes rules in declaration order and denies unmatched requests', async () => {
    const controller = new ScriptController({
      version: 1,
      approvals: [
        { tool: 'write_file', decision: 'approve' },
        { tool: 'run_shell', decision: 'approve', confirmation: 'run' },
      ],
    });
    const first = await controller.approvalHandler.decide(
      request({ tool: 'write_file', approvalId: 'apr_1' }),
    );
    expect(first).toEqual({ decision: 'approve', actor: 'script' });

    // A second write has no unused rule left → deny + script failure.
    const second = await controller.approvalHandler.decide(
      request({ tool: 'write_file', approvalId: 'apr_2' }),
    );
    expect(second.decision).toBe('deny');
    expect(controller.unmatched.length).toBe(1);
    expect(controller.failed).toBe(true);
  });

  it("exec requires the second attempt with confirmation 'run'", async () => {
    const controller = new ScriptController({
      version: 1,
      approvals: [{ tool: 'run_shell', decision: 'approve', confirmation: 'run' }],
    });
    const attempt1 = await controller.approvalHandler.decide(
      request({ tool: 'run_shell', risk: 'exec', attempt: 1, approvalId: 'apr_exec' }),
    );
    expect(attempt1).toEqual({ decision: 'approve', actor: 'script' });
    const attempt2 = await controller.approvalHandler.decide(
      request({ tool: 'run_shell', risk: 'exec', attempt: 2, approvalId: 'apr_exec' }),
    );
    expect(attempt2).toEqual({ decision: 'approve', actor: 'script', confirmation: 'run' });
    expect(controller.failed).toBe(false);
  });

  it('pairs exec attempts by tool, not approvalId (LangGraph re-executes the node)', async () => {
    const controller = new ScriptController({
      version: 1,
      approvals: [{ tool: 'run_shell', decision: 'approve', confirmation: 'run' }],
    });
    // Core re-runs the tools node on resume, so attempt 2 carries a NEW approvalId.
    await controller.approvalHandler.decide(
      request({ tool: 'run_shell', risk: 'exec', attempt: 1, approvalId: 'apr_first' }),
    );
    const attempt2 = await controller.approvalHandler.decide(
      request({ tool: 'run_shell', risk: 'exec', attempt: 2, approvalId: 'apr_regenerated' }),
    );
    expect(attempt2).toEqual({ decision: 'approve', actor: 'script', confirmation: 'run' });
    expect(controller.failed).toBe(false);
  });

  it("exec approve without confirmation 'run' denies the second attempt and fails", async () => {
    const controller = new ScriptController({
      version: 1,
      approvals: [{ tool: 'run_shell', decision: 'approve' }],
    });
    await controller.approvalHandler.decide(
      request({ tool: 'run_shell', risk: 'exec', attempt: 1, approvalId: 'apr_x' }),
    );
    const attempt2 = await controller.approvalHandler.decide(
      request({ tool: 'run_shell', risk: 'exec', attempt: 2, approvalId: 'apr_x' }),
    );
    expect(attempt2.decision).toBe('deny');
    expect(controller.failed).toBe(true);
  });

  it('occurrence targets the nth request for a tool; explicit deny does not fail the script', async () => {
    const controller = new ScriptController({
      version: 1,
      approvals: [
        { tool: 'write_file', decision: 'deny', occurrence: 1 },
        { tool: 'write_file', decision: 'approve', occurrence: 2 },
      ],
    });
    const first = await controller.approvalHandler.decide(
      request({ tool: 'write_file', approvalId: 'a1' }),
    );
    expect(first.decision).toBe('deny');
    const second = await controller.approvalHandler.decide(
      request({ tool: 'write_file', approvalId: 'a2' }),
    );
    expect(second.decision).toBe('approve');
    expect(controller.failed).toBe(false);
    expect(controller.denials.length).toBe(1);
  });

  it('argsMatch selects the rule for matching args, in declaration order', async () => {
    const controller = new ScriptController({
      version: 1,
      approvals: [
        { tool: 'write_file', decision: 'deny', argsMatch: { path: 'notes/forbidden.md' } },
        { tool: 'write_file', decision: 'approve', argsMatch: { path: 'notes/ok.md' } },
      ],
    });
    const denied = await controller.approvalHandler.decide(
      request({
        tool: 'write_file',
        approvalId: 'b1',
        argsPreview: { path: 'notes/forbidden.md', content: 'x' },
      }),
    );
    expect(denied.decision).toBe('deny');
    const approved = await controller.approvalHandler.decide(
      request({
        tool: 'write_file',
        approvalId: 'b2',
        argsPreview: { path: 'notes/ok.md', content: 'y' },
      }),
    );
    expect(approved.decision).toBe('approve');
    expect(controller.failed).toBe(false);
  });
});

describe('turn assertions', () => {
  it('expect.contains and expect.exitCode failures mark the script failed', () => {
    const controller = new ScriptController({ version: 1, approvals: [] });
    const turn = { input: 'hi', expect: { contains: 'hello world', exitCode: 0 } };

    controller.checkTurn(turn, 'hello world', 0);
    expect(controller.assertions.length).toBe(0);

    controller.checkTurn(turn, 'nope', 0);
    expect(controller.assertions.some((line) => line.includes('hello world'))).toBe(true);

    controller.checkTurn(turn, 'hello world', 5);
    expect(controller.assertions.some((line) => line.includes('exit code'))).toBe(true);
    expect(controller.failed).toBe(true);
  });
});
