import { afterEach, describe, expect, it } from 'vitest';
import { newEventId, newRunId, newSessionId, newSpanId } from '../../src/ids.js';
import {
  collectEnvSecretValues,
  isSensitiveKey,
  REDACTED,
  redactEvent,
  redactValue,
} from '../../src/events/redaction.js';
import { makeEvent, validateEvent, type AgentEvent } from '../../src/events/schema.js';

const SECRET_ENV = 'UNIT_EVENTS_API_KEY';
const SECRET_VALUE = 'sk-fake-secret-value';
const PLAIN_ENV = 'UNIT_EVENTS_PLAIN_VALUE';

describe('isSensitiveKey', () => {
  it('matches the credential key names from docs/03 §9', () => {
    for (const key of [
      'authorization',
      'Authorization',
      'api_key',
      'API_KEY',
      'apikey',
      'token',
      'secret',
      'password',
      'cookie',
      'Set-Cookie',
      'x-api-key',
      'OPENAI_API_KEY',
      'MY_SECRET',
      'user_token',
      'DB_PASSWORD',
      'AWS_CREDENTIAL_STORE',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not match ordinary telemetry keys', () => {
    for (const key of [
      'totalTokens',
      'inputTokens',
      'tokenBudget',
      'messageCount',
      'path',
      'approvalId',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });
});

describe('redactValue', () => {
  it('redacts nested secrets and omits headers entirely', () => {
    const input = {
      request: {
        url: 'https://api.example.com',
        headers: { authorization: 'Bearer leak', 'x-api-key': 'leak2' },
      },
      args: { path: 'notes/a.md', api_key: 'sk-nested', nested: { deep: { token: 't0ken' } } },
      list: [{ password: 'pw' }, { keep: 1 }],
    };
    const result = redactValue(input);

    expect(result.fieldsRedacted).toBe(4);
    const out = result.value as typeof input & {
      request: { headers: Record<string, unknown> };
      args: Record<string, unknown>;
    };
    expect(out.request.headers).toEqual({ '[omitted]': true });
    expect(JSON.stringify(out)).not.toContain('Bearer leak');
    expect(JSON.stringify(out)).not.toContain('sk-nested');
    expect(JSON.stringify(out)).not.toContain('t0ken');
    expect(JSON.stringify(out)).toContain('notes/a.md');
    expect((out.args as { nested: { deep: { token: string } } }).nested.deep.token).toBe(REDACTED);
    // headers, api_key, token, password
    expect(input.request.headers.authorization).toBe('Bearer leak');
  });

  it('leaks nothing when a whole headers map is nested in an array', () => {
    const result = redactValue({ calls: [{ headers: { cookie: 'session=abc' } }] });
    expect(result.value).toEqual({ calls: [{ headers: { '[omitted]': true } }] });
    expect(result.fieldsRedacted).toBe(1);
  });

  it('redacts values that equal a known secret even under an innocent key', () => {
    const result = redactValue(
      { note: { body: SECRET_VALUE, other: 'harmless' } },
      { secretValues: [SECRET_VALUE] },
    );
    expect(result.value).toEqual({ note: { body: REDACTED, other: 'harmless' } });
    expect(result.fieldsRedacted).toBe(1);
  });

  it('ignores secret values shorter than 6 chars so enums survive', () => {
    const result = redactValue({ risk: 'read', body: 'read' }, { secretValues: ['read'] });
    expect(result.fieldsRedacted).toBe(0);
    expect(result.value).toEqual({ risk: 'read', body: 'read' });
  });

  it('honours custom env name patterns', () => {
    const value = { aws_cred: 'hunter22', other: 'safe' };
    expect(redactValue(value, { envPatterns: ['*_CRED'] }).value).toEqual({
      aws_cred: REDACTED,
      other: 'safe',
    });
    expect(redactValue(value, { envPatterns: [] }).fieldsRedacted).toBe(0);
  });

  it('scalars pass through', () => {
    expect(redactValue('plain').fieldsRedacted).toBe(0);
    expect(redactValue(42).value).toBe(42);
    expect(redactValue(null).value).toBe(null);
  });
});

describe('redactEvent', () => {
  function event(payload: Record<string, unknown>): AgentEvent {
    return makeEvent({
      id: newEventId(),
      ts: '2026-11-03T12:00:00.000Z',
      sessionId: newSessionId(),
      runId: newRunId(),
      spanId: newSpanId(),
      type: 'tool.started',
      source: 'tool',
      payload,
    });
  }

  it('returns a new event with a redacted payload and keeps the envelope', () => {
    const original = event({
      name: 'run_shell',
      source: 'code',
      risk: 'exec',
      callId: 'call_1',
      argsTruncated: false,
      argsPreview: {
        command: 'printenv',
        note: SECRET_VALUE,
        env: { ANTHROPIC_API_KEY: SECRET_VALUE },
      },
    });
    const result = redactEvent(original, { secretValues: [SECRET_VALUE] });

    expect(result.event).not.toBe(original);
    expect(result.fieldsRedacted).toBe(2);
    expect(JSON.stringify(result.event)).not.toContain(SECRET_VALUE);
    expect(result.event.id).toBe(original.id);
    expect(result.event.sessionId).toBe(original.sessionId);
    expect(result.event.runId).toBe(original.runId);
    expect(result.event.spanId).toBe(original.spanId);
    expect(result.event.payload['name']).toBe('run_shell');
    expect(JSON.stringify(original)).toContain(SECRET_VALUE);
    expect(() => validateEvent(result.event)).not.toThrow();
  });

  it('keeps the identical event object when there is nothing to redact', () => {
    const original = event({
      name: 'read_file',
      source: 'code',
      risk: 'read',
      callId: 'call_1',
      argsTruncated: false,
      argsPreview: { path: 'notes/a.md' },
    });
    expect(redactEvent(original)).toEqual({ event: original, fieldsRedacted: 0 });
  });
});

describe('collectEnvSecretValues', () => {
  const saved = process.env[SECRET_ENV];
  const savedPlain = process.env[PLAIN_ENV];

  afterEach(() => {
    if (saved === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = saved;
    if (savedPlain === undefined) delete process.env[PLAIN_ENV];
    else process.env[PLAIN_ENV] = savedPlain;
  });

  it('reads only the named variables', () => {
    process.env[SECRET_ENV] = SECRET_VALUE;
    process.env[PLAIN_ENV] = 'plain-value';
    expect(collectEnvSecretValues([SECRET_ENV])).toEqual([SECRET_VALUE]);
    expect(collectEnvSecretValues([PLAIN_ENV])).toEqual(['plain-value']);
    expect(collectEnvSecretValues(['UNIT_EVENTS_ABSENT'])).toEqual([]);
  });

  it('without names only collects credential-shaped variables', () => {
    process.env[SECRET_ENV] = SECRET_VALUE;
    process.env[PLAIN_ENV] = 'plain-value';
    const values = collectEnvSecretValues();
    expect(values).toContain(SECRET_VALUE);
    expect(values).not.toContain('plain-value');
  });

  it('skips empty values so the bus never scrub an empty string', () => {
    process.env[SECRET_ENV] = '';
    expect(collectEnvSecretValues([SECRET_ENV])).toEqual([]);
  });
});
