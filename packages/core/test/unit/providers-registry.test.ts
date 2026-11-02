import { HumanMessage } from '@langchain/core/messages';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defineConfig,
  type ModelScript,
  type RawConfig,
  type ResolvedConfig,
} from '../../src/config/schema.js';
import { env } from '../../src/config/secret.js';
import { ConfigError, ProviderError, ShellError } from '../../src/errors/index.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { capabilitiesFor, formatModelRef, parseModelRef } from '../../src/providers/types.js';
import {
  fakeSecret,
  makeScriptedRegistry,
  makeTempWorkspace,
  ScriptedChatModel,
} from '../../src/testing/index.js';

const SCRIPT: ModelScript = { version: 1, steps: [{ content: 'first' }, { content: 'second' }] };

function configWith(
  providers: RawConfig['providers'],
  defaults?: Partial<RawConfig['defaults']>,
): ResolvedConfig {
  return defineConfig({ providers, ...(defaults === undefined ? {} : { defaults }) });
}

function scriptedConfig(provider: {
  script?: ModelScript | string;
  scripts?: Record<string, ModelScript | string>;
}): ResolvedConfig {
  return configWith({ mock: { kind: 'scripted', models: ['script'], ...provider } });
}

const NO_TOOL = { name: 'read_file', description: 'reads a file', jsonSchema: { type: 'object' } };

describe('model references', () => {
  it('parses provider:model and tolerates a trailing colon', () => {
    expect(parseModelRef('openai:gpt-4.1-mini')).toEqual({
      providerId: 'openai',
      model: 'gpt-4.1-mini',
    });
    expect(parseModelRef('mock')).toEqual({ providerId: 'mock' });
    expect(parseModelRef('mock:')).toEqual({ providerId: 'mock' });
    expect(formatModelRef({ providerId: 'mock', model: 'script' })).toBe('mock:script');
    expect(formatModelRef({ providerId: 'mock' })).toBe('mock');
  });

  it('rejects a reference without a provider id', () => {
    expect(() => parseModelRef(':gpt-4.1-mini')).toThrow(ConfigError);
  });
});

describe('createProviderRegistry', () => {
  it('lists and resolves configured providers with capabilities', () => {
    const registry = createProviderRegistry(
      configWith({
        primary: { kind: 'openai', apiKey: env('OPENAI_API_KEY'), models: ['gpt-4.1-mini'] },
        fallback: {
          kind: 'anthropic',
          apiKey: env('ANTHROPIC_API_KEY'),
          models: ['claude-haiku-4-5'],
        },
      }),
      { env: {} },
    );
    expect(registry.list().map((provider) => provider.id)).toEqual(['primary', 'fallback']);
    expect(registry.get('fallback').kind).toBe('anthropic');
    expect(registry.get('fallback').capabilities.contextWindow).toBe(200_000);
    expect(() => registry.get('nope')).toThrow(ConfigError);
  });

  it('names every available provider when the reference is unknown', async () => {
    const registry = createProviderRegistry(
      configWith({ alpha: { kind: 'scripted', script: SCRIPT } }),
      { env: {} },
    );
    await expect(registry.create('beta:model')).rejects.toThrow(/Unknown provider "beta"/);
    await expect(registry.create('beta:model')).rejects.toThrow(/Available providers: alpha/);
    expect(() => registry.get('beta')).toThrowError(/Available providers: alpha/);
  });

  it('asks for an explicit model when the provider declares none', async () => {
    const registry = createProviderRegistry(configWith({ mock: { kind: 'scripted' } }), {
      env: {},
    });
    await expect(registry.create('mock')).rejects.toThrow(/has no default model/);
  });

  it('reports the variable name, never the value, when the key is missing', async () => {
    process.env.AGENT_SHELL_UNIT_KEY = fakeSecret();
    try {
      const registry = createProviderRegistry(
        configWith({
          oai: { kind: 'openai', apiKey: env('AGENT_SHELL_UNIT_KEY'), models: ['gpt-4.1-mini'] },
        }),
        // Empty injected env proves the registry does not read process.env.
        { env: {} },
      );
      const failure = await registry.create('oai:gpt-4.1-mini').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ShellError);
      expect((failure as ShellError).code).toBe('CONFIG_MISSING_KEY');
      expect((failure as Error).message).toContain('AGENT_SHELL_UNIT_KEY');
      expect((failure as Error).message).not.toContain(fakeSecret());
    } finally {
      delete process.env.AGENT_SHELL_UNIT_KEY;
    }
  });

  it('builds a real handle when the key is present in the injected env', async () => {
    const registry = createProviderRegistry(
      configWith({
        oai: {
          kind: 'openai',
          apiKey: env('AGENT_SHELL_INJECTED_KEY'),
          models: ['gpt-4.1-mini'],
          baseURL: 'https://example.invalid/v1',
          headers: { 'x-trace': env('AGENT_SHELL_INJECTED_HEADER') },
        },
      }),
      { env: { AGENT_SHELL_INJECTED_KEY: fakeSecret(), AGENT_SHELL_INJECTED_HEADER: 'trace-id' } },
    );
    const handle = await registry.create('oai');
    expect(handle.providerId).toBe('oai');
    expect(handle.modelId).toBe('gpt-4.1-mini');
    expect(handle.kind).toBe('openai');
    expect(handle.timeoutMs).toBe(120_000);
    expect(handle.maxRetries).toBe(2);
    expect(handle.capabilities).toEqual(capabilitiesFor('openai', 'gpt-4.1-mini'));
  });

  it('refuses a header variable that is not set', async () => {
    const registry = createProviderRegistry(
      configWith({
        oai: {
          kind: 'openai',
          apiKey: env('AGENT_SHELL_KEY'),
          models: ['m'],
          headers: { 'x-trace': env('AGENT_SHELL_MISSING_HEADER') },
        },
      }),
      { env: { AGENT_SHELL_KEY: fakeSecret() } },
    );
    await expect(registry.create('oai:m')).rejects.toThrow(/AGENT_SHELL_MISSING_HEADER/);
  });

  it('caches one handle per resolved reference', async () => {
    const registry = makeScriptedRegistry(SCRIPT);
    const a = await registry.create('mock');
    const b = await registry.create('mock:script');
    expect(a).toBe(b);
    expect(a.providerId).toBe('mock');
    const model = a.model as ScriptedChatModel;
    expect(model).toBeInstanceOf(ScriptedChatModel);
    await a.invoke([new HumanMessage('x')], { tools: [] });
    expect(model.calls).toBe(1);
    await b.invoke([new HumanMessage('y')], { tools: [] });
    expect(model.calls).toBe(2);
    await expect(a.invoke([new HumanMessage('z')], { tools: [] })).rejects.toThrow(
      /script exhausted/,
    );
  });

  it('closes the registry and clears cached handles', async () => {
    const registry = makeScriptedRegistry(SCRIPT);
    await registry.create('mock');
    await registry.close();
    await expect(registry.create('mock')).rejects.toThrow(/registry is closed/);
  });

  it('defaults the reference from defaults.provider', () => {
    const registry = createProviderRegistry(
      configWith({ mock: { kind: 'scripted', script: SCRIPT } }),
      { env: {} },
    );
    expect(registry.list()[0]?.id).toBe('mock');
  });

  describe('scripted provider wiring', () => {
    it('prefers the most specific script key', async () => {
      const registry = createProviderRegistry(
        scriptedConfig({
          script: SCRIPT,
          scripts: {
            'mock:other': { version: 1, steps: [{ content: 'model key' }] },
            mock: { version: 1, steps: [{ content: 'provider key' }] },
          },
        }),
        { env: {} },
      );
      const byModel = await registry.create('mock:other');
      expect((await byModel.invoke([new HumanMessage('go')], { tools: [] })).message.content).toBe(
        'model key',
      );
      const byProvider = await registry.create('mock:script');
      expect(
        (await byProvider.invoke([new HumanMessage('go')], { tools: [] })).message.content,
      ).toBe('provider key');
    });

    it('resolves a script reference through the scriptResolver', async () => {
      const seen: string[] = [];
      const registry = createProviderRegistry(scriptedConfig({ script: 'scripts/offline.json' }), {
        env: {},
        scriptResolver: (ref: string) => {
          seen.push(ref);
          return { version: 1, steps: [{ content: `resolved:${ref}` }] };
        },
      });
      const handle = await registry.create('mock:script');
      const result = await handle.invoke([new HumanMessage('go')], { tools: [] });
      expect(result.message.content).toBe('resolved:scripts/offline.json');
      expect(seen).toEqual(['scripts/offline.json']);
      // No usage in the script means the shell estimates, and says so.
      expect(result.usage.estimated).toBe(true);
    });

    it('errors when no script matches the requested model', async () => {
      const registry = createProviderRegistry(scriptedConfig({ scripts: {} }), { env: {} });
      await expect(registry.create('mock:script')).rejects.toThrow(
        /has no script for model "script"/,
      );
    });

    it('reads a script file from disk', async () => {
      const workspace = await makeTempWorkspace({
        'scripts/offline.json': JSON.stringify({ version: 1, steps: [{ content: 'from file' }] }),
      });
      try {
        const registry = createProviderRegistry(
          scriptedConfig({ script: path.join(workspace.dir, 'scripts/offline.json') }),
          { env: {} },
        );
        const handle = await registry.create('mock:script');
        expect((await handle.invoke([new HumanMessage('go')], { tools: [] })).message.content).toBe(
          'from file',
        );
      } finally {
        await workspace.cleanup();
      }
    });

    it('streams scripted text chunk by chunk and reports the finish reason', async () => {
      const registry = makeScriptedRegistry({
        version: 1,
        steps: [
          { content: 'abcd', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
          { content: 'abcd', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } },
        ],
      });
      const handle = await registry.create('mock');
      const tokens: string[] = [];
      const collected: string[] = [];
      for await (const chunk of handle.stream([new HumanMessage('go')], {
        tools: [],
        streamTokens: (token) => tokens.push(token),
      })) {
        collected.push(chunk);
      }
      expect(collected.join('')).toBe('abcd');
      expect(tokens).toEqual(['a', 'b', 'c', 'd']);
      const result = await handle.invoke([new HumanMessage('again')], { tools: [] });
      expect(result.usage).toEqual({
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        estimated: false,
      });
      expect(result.finishReason).toBe('stop');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.firstTokenMs).toBeCloseTo(result.durationMs, 1);
    });
  });

  describe('capability guard', () => {
    it('refuses tools on a model that cannot call tools', async () => {
      const registry = makeScriptedRegistry(SCRIPT, { capabilities: { toolCalling: false } });
      const handle = await registry.create('mock');
      const failure = await handle
        .invoke([new HumanMessage('go')], { tools: [NO_TOOL] })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).code).toBe('PROVIDER_PROTOCOL');
      expect((failure as Error).message).toMatch(/does not support tool calling/);
      expect((failure as Error).message).toContain('read_file');
    });

    it('does not consume a script step when the guard rejects the call', async () => {
      const registry = makeScriptedRegistry(SCRIPT, { capabilities: { toolCalling: false } });
      const handle = await registry.create('mock');
      await expect(handle.invoke([new HumanMessage('go')], { tools: [NO_TOOL] })).rejects.toThrow(
        ProviderError,
      );
      const stream = handle.stream([new HumanMessage('go')], { tools: [NO_TOOL] });
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(ProviderError);
      expect((handle.model as ScriptedChatModel).calls).toBe(0);
    });

    it('lets tool-capable models pass the guard through', async () => {
      const registry = makeScriptedRegistry({
        version: 1,
        steps: [{ toolCalls: [{ name: 'read_file', args: { path: 'notes/a.md' } }] }],
      });
      const handle = await registry.create('mock');
      const result = await handle.invoke([new HumanMessage('go')], {
        tools: [
          {
            name: 'read_file',
            description: 'reads a file',
            jsonSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      });
      expect((handle.model as ScriptedChatModel).boundToolNames).toEqual(['read_file']);
      expect(result.finishReason).toBe('tool_calls');
    });
  });
});
