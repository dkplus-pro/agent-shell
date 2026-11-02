import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HumanMessage } from '@langchain/core/messages';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig, type RawConfig, type ResolvedConfig } from '../../src/config/schema.js';
import { env } from '../../src/config/secret.js';
import { ProviderError } from '../../src/errors/index.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { fakeSecret } from '../../src/testing/index.js';

const KEY_VARIABLE = 'AGENT_SHELL_CONTRACT_OPENAI_KEY';
const HEADER_VARIABLE = 'AGENT_SHELL_CONTRACT_OPENAI_HEADER';
const MODEL = 'gpt-4.1-mini';

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface ToolPayload {
  type: string;
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

interface MessagePayload {
  role: string;
  content: string;
}

type Handler = (state: Recorded[], res: http.ServerResponse) => void;

function sse(res: http.ServerResponse, payloads: readonly string[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(payloads.map((payload) => `data: ${payload}\n\n`).join('') + 'data: [DONE]\n\n');
}

function chunk(text: string, index: number, finish?: string): string {
  return JSON.stringify({
    id: `chatcmpl_${index}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: index === 0 ? { role: 'assistant', content: text } : { content: text },
        ...(finish === undefined ? {} : { finish_reason: finish }),
      },
    ],
  });
}

function textStream(texts: readonly string[], usage?: Record<string, number>): string[] {
  const payloads = texts.map((text, index) => chunk(text, index));
  payloads.push(chunk('', texts.length, 'stop'));
  if (usage !== undefined) {
    payloads.push(
      JSON.stringify({
        id: 'chatcmpl_usage',
        object: 'chat.completion.chunk',
        created: 1,
        model: MODEL,
        choices: [],
        usage,
      }),
    );
  }
  return payloads;
}

const TOOL_CALL_STREAM = [
  JSON.stringify({
    id: 'chatcmpl_tool',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":' },
            },
            { index: 0, function: { arguments: '"notes/a.md"}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }),
  JSON.stringify({
    id: 'chatcmpl_tool_usage',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL,
    choices: [],
    usage: { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 },
  }),
];

type OpenAIInput = Extract<NonNullable<RawConfig['providers']>[string], { kind: 'openai' }>;

function configFor(baseUrl: string, overrides: Partial<OpenAIInput> = {}): ResolvedConfig {
  const providers = {
    oai: {
      kind: 'openai' as const,
      apiKey: env(KEY_VARIABLE),
      baseURL: baseUrl,
      models: [MODEL],
      timeoutMs: 30_000,
      maxRetries: 2,
      headers: {},
      ...overrides,
    },
  };
  return defineConfig({ providers, defaults: { provider: `oai:${MODEL}` } });
}

let server: http.Server | undefined;
let baseUrl = '';
let requests: Recorded[] = [];
let pending: http.ServerResponse[] = [];
let handler: Handler = (_state, res) => {
  sse(res, textStream(['default'], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
};

function handleWith(next: Handler): void {
  // Per-test state: a test must never see another test's requests or sockets.
  requests = [];
  pending = [];
  handler = next;
}

function registryFor(config: ResolvedConfig): ReturnType<typeof createProviderRegistry> {
  return createProviderRegistry(config, {
    env: { [KEY_VARIABLE]: fakeSecret(), [HEADER_VARIABLE]: 'header-value' },
  });
}

function recorded(index: number): Recorded {
  const entry = requests[index];
  if (entry === undefined)
    throw new Error(`mock server received only ${requests.length} request(s)`);
  return entry;
}

/**
 * Test-side network guard: contract tests may only talk to the loopback mock.
 */
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/**
 * ChatOpenAI's streaming `invoke` always estimates token usage, and
 * @langchain/core answers that by downloading BPE ranks from
 * `https://tiktoken.pages.dev/...` through its `AsyncCaller`. The caller
 * retries an ordinary rejected fetch six times with randomised exponential
 * backoff (~60-95s per chain) and evicts its cache on every failure, so a plain
 * rejection makes each test stall for minutes. `AsyncCaller`'s failed-attempt
 * handler treats an `AbortError` as terminal, so naming the block that way keeps
 * the offline guarantee while failing instantly. It must stay a rejected
 * promise: a synchronous throw escapes the handler, and a never-settling
 * promise hangs the run.
 */
class BlockedRequestError extends Error {
  constructor(url: string) {
    super(`Blocked non-loopback request to ${url}`);
    this.name = 'AbortError';
  }
}

function installLoopbackOnlyFetch(): () => void {
  const nativeFetch = globalThis.fetch;
  const guarded = (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url?: string }).url ?? String(input));
    if (!LOOPBACK.test(url)) return Promise.reject(new BlockedRequestError(url));
    return nativeFetch(input as Parameters<typeof nativeFetch>[0], init);
  };
  globalThis.fetch = guarded as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = nativeFetch;
  };
}

let uninstallFetch: (() => void) | undefined;

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    const instance = http.createServer((req, res) => {
      const buffers: Buffer[] = [];
      req.on('data', (buffer: Buffer) => buffers.push(buffer));
      req.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(buffers).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const entry: Recorded = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body,
        };
        requests.push(entry);
        pending.push(res);
        handler(requests, res);
      });
    });
    instance.once('error', reject);
    instance.once('listening', () => {
      server = instance;
      baseUrl = `http://127.0.0.1:${(instance.address() as AddressInfo).port}/v1`;
      resolve();
    });
    instance.listen(0, '127.0.0.1');
  });
  uninstallFetch = installLoopbackOnlyFetch();
});

afterEach(() => {
  for (const res of pending) {
    if (!res.writableEnded) res.destroy();
  }
  pending = [];
});

afterAll(async () => {
  uninstallFetch?.();
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) {
      resolve();
      return;
    }
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe('OpenAI provider contract (local HTTP mock)', () => {
  it('streams text over SSE and sends the bearer key, model and messages', async () => {
    handleWith((_state, res) => {
      sse(
        res,
        textStream(['Hel', 'lo the', 're'], {
          prompt_tokens: 11,
          completion_tokens: 5,
          total_tokens: 16,
        }),
      );
    });
    const handle = await registryFor(configFor(baseUrl)).create(`oai:${MODEL}`);
    const collected: string[] = [];
    for await (const piece of handle.stream([new HumanMessage('greet me')], { tools: [] })) {
      collected.push(piece);
    }
    expect(collected.join('')).toBe('Hello there');

    const request = recorded(0);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.headers.authorization).toBe(`Bearer ${fakeSecret()}`);
    expect(request.body.model).toBe(MODEL);
    expect(request.body.stream).toBe(true);
    const messages = request.body.messages as MessagePayload[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe('greet me');
  });

  it('returns a tool-call turn and serialises the offered JSON schema', async () => {
    handleWith((_state, res) => {
      sse(res, TOOL_CALL_STREAM);
    });
    const handle = await registryFor(configFor(baseUrl)).create('oai');
    const result = await handle.invoke([new HumanMessage('read notes/a.md')], {
      tools: [
        {
          name: 'read_file',
          description: 'Reads a file inside the workspace',
          jsonSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.message.getType()).toBe('ai');
    const toolCalls = 'tool_calls' in result.message ? result.message.tool_calls : undefined;
    expect(toolCalls).toEqual([
      { name: 'read_file', args: { path: 'notes/a.md' }, id: 'call_1', type: 'tool_call' },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 6,
      totalTokens: 23,
      estimated: false,
    });

    const tools = recorded(0).body.tools as ToolPayload[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.function.name).toBe('read_file');
    expect(tools[0]?.function.description).toBe('Reads a file inside the workspace');
    expect(tools[0]?.function.parameters).toMatchObject({ type: 'object', required: ['path'] });
  });

  it('estimates usage when the stream carries none', async () => {
    handleWith((_state, res) => {
      sse(res, textStream(['no usage here']));
    });
    const handle = await registryFor(configFor(baseUrl)).create('oai');
    const result = await handle.invoke([new HumanMessage('a prompt of some length')], {
      tools: [],
    });
    expect(result.message.content).toBe('no usage here');
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    handleWith((state, res) => {
      if (state.length === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
        return;
      }
      sse(
        res,
        textStream(['recovered'], { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }),
      );
    });
    const handle = await registryFor(configFor(baseUrl)).create('oai');
    const result = await handle.invoke([new HumanMessage('go')], { tools: [] });
    expect(result.message.content).toBe('recovered');
    expect(requests).toHaveLength(2);
  }, 30_000);

  it('gives up with a ProviderError after exhausting 500 retries', async () => {
    handleWith((_state, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'boom' } }));
    });
    const handle = await registryFor(configFor(baseUrl)).create('oai');
    const failure = await handle
      .invoke([new HumanMessage('go')], { tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('network');
    expect((failure as Error).message).not.toContain(fakeSecret());
    expect(requests).toHaveLength(3);
  }, 30_000);

  it('maps an unresponsive upstream to a timeout ProviderError', async () => {
    handleWith((_state, res) => {
      // Headers are buffered until the first write, so the server sends no
      // bytes at all and the client-side timeout must fire.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
    });
    const handle = await registryFor(configFor(baseUrl, { timeoutMs: 250, maxRetries: 0 })).create(
      'oai',
    );
    const failure = await handle
      .invoke([new HumanMessage('go')], { tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('timeout');
    expect((failure as Error).message).not.toContain(fakeSecret());
  }, 20_000);

  it('honours an aborted signal', async () => {
    handleWith((_state, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
    });
    const handle = await registryFor(configFor(baseUrl)).create('oai');
    const controller = new AbortController();
    const inFlight = handle.invoke([new HumanMessage('go')], {
      tools: [],
      signal: controller.signal,
    });
    controller.abort();
    const failure = await inFlight.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('timeout');
  });

  it('maps a non event-stream success body to a protocol ProviderError', async () => {
    handleWith((_state, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ unexpected: 'payload' }));
    });
    const handle = await registryFor(configFor(baseUrl, { maxRetries: 0 })).create('oai');
    const failure = await handle
      .invoke([new HumanMessage('go')], { tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('protocol');
  });

  it('forwards configured header variables as resolved values', async () => {
    handleWith((_state, res) => {
      sse(res, textStream(['ok'], { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    });
    const registry = registryFor(
      configFor(baseUrl, { headers: { 'x-custom': env(HEADER_VARIABLE) } }),
    );
    const handle = await registry.create('oai');
    await handle.invoke([new HumanMessage('go')], { tools: [] });
    expect(recorded(0).headers['x-custom']).toBe('header-value');
    expect(recorded(0).headers.authorization).toBe(`Bearer ${fakeSecret()}`);
  });
});
