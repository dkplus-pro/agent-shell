/**
 * Trace redaction (docs/03-cli-and-trace.md §9). Secrets only ever come from the
 * environment (AGENT.md §5), so the policy is: never record a value that arrived
 * under a credential-shaped key, never record HTTP headers at all, and never
 * record a string that equals a known environment secret.
 */
import { traceConfigSchema } from '../config/schema.js';
import type { AgentEvent } from './schema.js';

export const REDACTED = '[redacted]';

/** Stand-in for a dropped `headers` object: the key stays, no value is recorded. */
const OMITTED_KEY = '[omitted]';

/** Exact key matches only — substring matching would nuke `totalTokens` (docs/03 §9). */
const SENSITIVE_KEYS: readonly string[] = [
  'authorization',
  'api_key',
  'apikey',
  'token',
  'secret',
  'password',
  'cookie',
  'set-cookie',
  'x-api-key',
];

const SHORT_VALUE_FLOOR = 6;

export interface RedactionOptions {
  /** Literal values (e.g. revealed from an env var) that must never be recorded. */
  secretValues?: string[];
  /** Glob-ish patterns over environment-variable / key NAMES; defaults to trace config. */
  envPatterns?: string[];
}

let defaultPatterns: string[] | undefined;
const regexCache = new Map<string, RegExp>();

function envPatternsFor(patterns: string[] | undefined): string[] {
  if (patterns !== undefined) return patterns;
  defaultPatterns ??= traceConfigSchema.parse({}).redactEnvPrefixes;
  return defaultPatterns;
}

function nameMatcher(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  // Anchored so "*_TOKEN" cannot match "tokenBudget"; only "*" is a wildcard.
  const source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${source}$`, 'i');
  regexCache.set(pattern, regex);
  return regex;
}

export function isSensitiveKey(key: string): boolean {
  return matchesSensitive(key, envPatternsFor(undefined));
}

function matchesSensitive(key: string, patterns: string[]): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_KEYS.includes(lower)) return true;
  return patterns.some((pattern) => nameMatcher(pattern).test(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface RedactedNode {
  value: unknown;
  fieldsRedacted: number;
}

function walk(value: unknown, secrets: string[], patterns: string[]): RedactedNode {
  if (Array.isArray(value)) {
    let count = 0;
    const items = value.map((item) => {
      const node = walk(item, secrets, patterns);
      count += node.fieldsRedacted;
      return node.value;
    });
    return { value: items, fieldsRedacted: count };
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (key.toLowerCase() === 'headers') {
        out[key] = { [OMITTED_KEY]: true };
        count += 1;
        continue;
      }
      if (matchesSensitive(key, patterns)) {
        out[key] = REDACTED;
        count += 1;
        continue;
      }
      const node = walk(item, secrets, patterns);
      count += node.fieldsRedacted;
      out[key] = node.value;
    }
    return { value: out, fieldsRedacted: count };
  }

  if (typeof value === 'string' && secrets.includes(value)) {
    return { value: REDACTED, fieldsRedacted: 1 };
  }

  return { value, fieldsRedacted: 0 };
}

export function redactValue<T>(
  value: T,
  opts: RedactionOptions = {},
): { value: unknown; fieldsRedacted: number } {
  const secrets = (opts.secretValues ?? []).filter(
    (secret) => typeof secret === 'string' && secret.length >= SHORT_VALUE_FLOOR,
  );
  return walk(value, secrets, envPatternsFor(opts.envPatterns));
}

/**
 * Returns a new event: recorded events are append-only, and envelope ids are
 * contract fields (docs/03 §6.1) so only the payload is walked.
 */
export function redactEvent(
  event: AgentEvent,
  opts?: RedactionOptions,
): { event: AgentEvent; fieldsRedacted: number } {
  const redacted = redactValue(event.payload, opts);
  if (redacted.fieldsRedacted === 0) return { event, fieldsRedacted: 0 };
  const payload = isRecord(redacted.value) ? redacted.value : event.payload;
  return { event: { ...event, payload }, fieldsRedacted: redacted.fieldsRedacted };
}

/**
 * Reads the VALUES of the named environment variables so the bus can scrub them.
 * With no explicit names only credential-shaped names are read — never the whole
 * environment.
 */
export function collectEnvSecretValues(names?: string[]): string[] {
  const values = new Set<string>();
  for (const name of names ?? Object.keys(process.env)) {
    if (names === undefined && !isSensitiveKey(name)) continue;
    const value = process.env[name];
    if (value !== undefined && value.length > 0) values.add(value);
  }
  return [...values];
}
