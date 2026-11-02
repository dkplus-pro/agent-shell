/**
 * Unit tests for REPL command dispatch (docs/03 §2) with injected fakes —
 * exercises the semantics (state switching, redaction, exit) without a TTY.
 */
import type { ResolvedConfig } from '@agent-shell/core';
import { describe, expect, it } from 'vitest';
import {
  dispatchReplCommand,
  parseReplLine,
  type ReplCommandDeps,
  type ReplState,
} from '../../src/repl/commands.js';

const config = {
  defaults: { preset: 'single', agent: 'default' },
  presets: { single: { kind: 'single', agent: 'default' }, team: { kind: 'supervisor' } },
  providers: {},
} as unknown as ResolvedConfig;

function makeDeps(overrides: Partial<ReplCommandDeps> = {}): {
  deps: ReplCommandDeps;
  state: ReplState;
} {
  const state: ReplState = { preset: 'single', resumed: false, turnCount: 0 };
  const deps: ReplCommandDeps = {
    state,
    config,
    tools: (source) => [`tools(${source ?? 'all'})`],
    plugins: () => ['plugins: 0'],
    mcp: () => ['mcp: none'],
    providers: () => ['providers: fake'],
    sessions: async () => ['ses_one', 'ses_two'],
    history: (n) => [`history(${n})`],
    trace: () => ['trace: .agent-shell/traces/ses_x/run_y.jsonl'],
    configView: () => ['{ "apiKey": "[redacted]" }'],
    newSession: () => {
      state.sessionId = 'ses_fresh';
      state.turnCount = 0;
    },
    ...overrides,
  };
  return { deps, state };
}

describe('parseReplLine', () => {
  it('recognizes only slash commands and splits the argument', () => {
    expect(parseReplLine('/help')).toEqual({ command: '/help', argument: '' });
    expect(parseReplLine('  /Provider fake:model ')).toEqual({
      command: '/provider',
      argument: 'fake:model',
    });
    expect(parseReplLine('plain text')).toBeUndefined();
  });
});

describe('dispatch', () => {
  it('/help lists the documented commands', async () => {
    const { deps } = makeDeps();
    const result = await dispatchReplCommand('/help', deps);
    expect(result.kind).toBe('output');
    if (result.kind !== 'output') return;
    for (const command of [
      '/provider',
      '/preset',
      '/tools',
      '/history',
      '/new',
      '/sessions',
      '/config',
      '/quit',
    ]) {
      expect(result.lines.join('\n')).toContain(command);
    }
  });

  it('/provider warns when switching provider mid-session', async () => {
    const { deps, state } = makeDeps();
    state.provider = 'openai:gpt-4.1-mini';
    state.turnCount = 2;

    const switched = await dispatchReplCommand('/provider anthropic:claude-sonnet-4-6', deps);
    expect(switched.kind).toBe('output');
    const lines = (switched as { lines: string[] }).lines;
    expect(lines.join('\n')).toMatch(/best-effort|\/new/);

    // A model change inside the same provider is not a cross-provider switch.
    const same = await dispatchReplCommand('/provider anthropic:claude-haiku-4-5', deps);
    expect((same as { lines: string[] }).lines.join('\n')).not.toMatch(/best-effort/);
  });

  it('/provider shows current, switches next run, and validates refs', async () => {
    const { deps, state } = makeDeps();
    const shown = await dispatchReplCommand('/provider', deps);
    expect(shown.kind).toBe('output');

    const switched = await dispatchReplCommand('/provider fake:model', deps);
    expect(switched.kind).toBe('output');
    expect(state.provider).toBe('fake:model');

    const bad = await dispatchReplCommand('/provider :model', deps);
    expect(bad.kind).toBe('error');
  });

  it('/preset rejects unknown presets', async () => {
    const { deps, state } = makeDeps();
    const ok = await dispatchReplCommand('/preset team', deps);
    expect(ok.kind).toBe('output');
    expect(state.preset).toBe('team');
    const bad = await dispatchReplCommand('/preset ghost', deps);
    expect(bad.kind).toBe('error');
  });

  it('/tools filters by source and rejects bad sources', async () => {
    const { deps } = makeDeps();
    const all = await dispatchReplCommand('/tools', deps);
    expect(all.kind).toBe('output');
    const filtered = await dispatchReplCommand('/tools mcp', deps);
    expect(filtered.kind).toBe('output');
    if (filtered.kind === 'output') expect(filtered.lines[0]).toContain('mcp');
    const bad = await dispatchReplCommand('/tools bogus', deps);
    expect(bad.kind).toBe('error');
  });

  it('/history defaults to 10 and takes a count', async () => {
    const { deps } = makeDeps();
    const a = await dispatchReplCommand('/history', deps);
    expect(a.kind === 'output' && a.lines[0]).toBe('history(10)');
    const b = await dispatchReplCommand('/history 3', deps);
    expect(b.kind === 'output' && b.lines[0]).toBe('history(3)');
    const bad = await dispatchReplCommand('/history zero', deps);
    expect(bad.kind).toBe('error');
  });

  it('/new starts a fresh session', async () => {
    const { deps, state } = makeDeps();
    state.sessionId = 'ses_old';
    state.resumed = true;
    state.turnCount = 4;
    const result = await dispatchReplCommand('/new', deps);
    expect(result.kind).toBe('output');
    expect(state.sessionId).toBe('ses_fresh');
  });

  it('/session reports current state', async () => {
    const { deps, state } = makeDeps();
    state.sessionId = 'ses_here';
    state.turnCount = 2;
    const result = await dispatchReplCommand('/session', deps);
    expect(result.kind === 'output' && result.lines.join('\n')).toContain('ses_here');
    expect(result.kind === 'output' && result.lines.join('\n')).toContain('turns: 2');
  });

  it('/config output is redacted (secret never echoed)', async () => {
    const { deps } = makeDeps({
      configView: () => ['{ "providers": { "openai": { "apiKey": "[redacted]" } } }'],
    });
    const result = await dispatchReplCommand('/config', deps);
    const text = result.kind === 'output' ? result.lines.join('\n') : '';
    expect(text).toContain('redacted');
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it('/trace shows the trace path', async () => {
    const { deps } = makeDeps();
    const result = await dispatchReplCommand('/trace', deps);
    expect(result.kind === 'output' && result.lines.join('\n')).toContain('traces');
  });

  it('/quit and /exit end the REPL with code 0; unknown commands error', async () => {
    const { deps } = makeDeps();
    expect(await dispatchReplCommand('/quit', deps)).toEqual({ kind: 'exit', code: 0 });
    expect(await dispatchReplCommand('/exit', deps)).toEqual({ kind: 'exit', code: 0 });
    const unknown = await dispatchReplCommand('/frobnicate', deps);
    expect(unknown.kind).toBe('error');
  });
});
