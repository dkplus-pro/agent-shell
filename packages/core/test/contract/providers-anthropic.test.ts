import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig, type RawConfig, type ResolvedConfig } from '../../src/config/schema.js';
import { env } from '../../src/config/secret.js';
import { ProviderError } from '../../src/errors/index.js';
import { createProviderRegistry } from '../../src/providers/registry.js';
import { fakeSecret } from '../../src/testing/index.js';

const KEY_VARIABLE = 'AGENT_SHELL_CONTRACT_ANTHROPIC_KEY';
const HEADER_VARIABLE = 'AGENT_SHELL_CONTRACT_ANTHROPIC_HEADER';
const MODEL = 'claude-sonnet-4-6';

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface AnthropicToolPayload {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicMessagePayload {
  role: string;
  content: unknown;
}

type Handler = (state: Recorded[], res: http.ServerResponse) => void;

function sse(res: http.ServerResponse, events: readonly unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const body = events
    .map((event) => {
      const type = (event as { type?: string }).type ?? 'message_stop';
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
  res.end(body);
}

interface MockUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * ChatAnthropic reads `usage` on both message_start and message_delta without
 * guards, so a faithful mock always sends both (zeros mean "no usage").
 */
function messageStart(usage: MockUsage): unknown {
  return {
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  };
}

function textEvents(texts: readonly string[], usage: MockUsage, streamedTokens: number): unknown[] {
  return [
    messageStart(usage),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...texts.map((text) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: streamedTokens },
    },
    { type: 'message_stop' },
  ];
}

const TOOL_EVENTS: unknown[] = [
  messageStart({ input_tokens: 21, output_tokens: 1 }),
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_mock', name: 'read_file', input: {} },
  },
  ...['{"path":', '"notes/', 'a.md"}'].map((partial) => ({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: partial },
  })),
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 9 },
  },
  { type: 'message_stop' },
];

type AnthropicInput = Extract<NonNullable<RawConfig['providers']>[string], { kind: 'anthropic' }>;

function configFor(baseUrl: string, overrides: Partial<AnthropicInput> = {}): ResolvedConfig {
  const providers = {
    ant: {
      kind: 'anthropic' as const,
      apiKey: env(KEY_VARIABLE),
      baseURL: baseUrl,
      models: [MODEL],
      timeoutMs: 30_000,
      maxRetries: 2,
      headers: {},
      ...overrides,
    },
  };
  return defineConfig({ providers, defaults: { provider: `ant:${MODEL}` } });
}

let server: http.Server | undefined;
let baseUrl = '';
let requests: Recorded[] = [];
let pending: http.ServerResponse[] = [];
const NO_USAGE: MockUsage = { input_tokens: 0, output_tokens: 0 };

let handler: Handler = (_state, res) => {
  sse(res, textEvents(['ok'], { input_tokens: 2, output_tokens: 1 }, 1));
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
 * A blocked request must reject, never throw synchronously and never hang, and
 * it must be shaped so @langchain/core's `AsyncCaller` treats it as terminal:
 * that caller retries an ordinary rejected fetch six times with randomised
 * exponential backoff (~60-95s per chain), which is what stalls the sibling
 * OpenAI file when the rejection is a plain `Error`. `AbortError` is the name
 * its failed-attempt handler stops on.
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
      baseUrl = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
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

describe('Anthropic provider contract (local HTTP mock)', () => {
  it('streams text over SSE with the x-api-key header and system prompt', async () => {
    handleWith((_state, res) => {
      sse(res, textEvents(['Hel', 'lo Cl', 'aude'], { input_tokens: 12, output_tokens: 2 }, 3));
    });
    const handle = await registryFor(configFor(baseUrl)).create(`ant:${MODEL}`);
    const collected: string[] = [];
    for await (const piece of handle.stream(
      [new SystemMessage('Be terse.'), new HumanMessage('greet me')],
      { tools: [] },
    )) {
      collected.push(piece);
    }
    expect(collected.join('')).toBe('Hello Claude');

    const request = recorded(0);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/messages');
    expect(request.headers['x-api-key']).toBe(fakeSecret());
    expect(request.headers['anthropic-version']).toBeTruthy();
    expect(request.body.model).toBe(MODEL);
    expect(request.body.stream).toBe(true);
    expect(request.body.system).toBe('Be terse.');
    const messages = request.body.messages as AnthropicMessagePayload[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('returns a tool-call turn with input_schema sent to the mock', async () => {
    handleWith((_state, res) => {
      sse(res, TOOL_EVENTS);
    });
    const handle = await registryFor(configFor(baseUrl)).create('ant');
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
    expect(result.finishReason).toBe('tool_use');
    const toolCalls = 'tool_calls' in result.message ? result.message.tool_calls : undefined;
    expect(toolCalls).toEqual([
      { name: 'read_file', args: { path: 'notes/a.md' }, id: 'toolu_mock', type: 'tool_call' },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 21,
      outputTokens: 10,
      totalTokens: 31,
      estimated: false,
    });

    const tools = recorded(0).body.tools as AnthropicToolPayload[];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('read_file');
    expect(tools[0]?.description).toBe('Reads a file inside the workspace');
    expect(tools[0]?.input_schema).toMatchObject({ type: 'object', required: ['path'] });
  });

  it('estimates usage when the mock reports none', async () => {
    handleWith((_state, res) => {
      // A gateway that strips usage answers with zeros everywhere.
      sse(res, textEvents(['no usage'], NO_USAGE, 0));
    });
    const handle = await registryFor(configFor(baseUrl)).create('ant');
    const result = await handle.invoke([new HumanMessage('a prompt of some length')], {
      tools: [],
    });
    expect(result.message.content).toBe('no usage');
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('retries a 429 and succeeds on the second attempt', async () => {
    handleWith((state, res) => {
      if (state.length === 1) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'slow down' },
          }),
        );
        return;
      }
      sse(res, textEvents(['recovered'], { input_tokens: 4, output_tokens: 1 }, 2));
    });
    const handle = await registryFor(configFor(baseUrl)).create('ant');
    const result = await handle.invoke([new HumanMessage('go')], { tools: [] });
    expect(result.message.content).toBe('recovered');
    expect(requests).toHaveLength(2);
  }, 30_000);

  it('gives up with a ProviderError after exhausting 500 retries', async () => {
    handleWith((_state, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }));
    });
    const handle = await registryFor(configFor(baseUrl)).create('ant');
    const failure = await handle
      .invoke([new HumanMessage('go')], { tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('network');
    expect((failure as Error).message).not.toContain(fakeSecret());
    // maxRetries 2 means two retries, i.e. three requests in total. The adapter
    // must keep ChatAnthropic's SDK-level retries disabled, otherwise the two
    // retry layers multiply to (maxRetries + 1)² requests.
    expect(requests).toHaveLength(3);
  }, 30_000);

  it('maps an auth rejection to an auth ProviderError', async () => {
    handleWith((_state, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      );
    });
    const handle = await registryFor(configFor(baseUrl, { maxRetries: 0 })).create('ant');
    const failure = await handle
      .invoke([new HumanMessage('go')], { tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('auth');
    expect((failure as Error).message).not.toContain(fakeSecret());
  }, 20_000);

  it('maps an unresponsive upstream to a timeout ProviderError', async () => {
    handleWith((_state, res) => {
      // Headers stay buffered until the first write, so no byte is sent.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
    });
    const handle = await registryFor(configFor(baseUrl, { timeoutMs: 250, maxRetries: 0 })).create(
      'ant',
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
      res.write('event: ping\ndata: {"type": "ping"}\n\n');
    });
    const handle = await registryFor(configFor(baseUrl)).create('ant');
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
    const handle = await registryFor(configFor(baseUrl, { maxRetries: 0 })).create('ant');
    const failure = await handle
      .invoke([new HumanMessage('go')], { tools: [] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).fields.kind).toBe('protocol');
  });

  it('forwards configured header variables as resolved values', async () => {
    handleWith((_state, res) => {
      sse(res, textEvents(['ok'], { input_tokens: 1, output_tokens: 1 }, 1));
    });
    const registry = registryFor(
      configFor(baseUrl, { headers: { 'x-custom': env(HEADER_VARIABLE) } }),
    );
    const handle = await registry.create('ant');
    await handle.invoke([new HumanMessage('go')], { tools: [] });
    expect(recorded(0).headers['x-custom']).toBe('header-value');
    expect(recorded(0).headers['x-api-key']).toBe(fakeSecret());
  });
});
