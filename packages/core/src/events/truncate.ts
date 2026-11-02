/**
 * Preview truncation for trace fields (docs/03-cli-and-trace.md §9). The trace
 * must stay readable but bounded, so every preview keeps the `sha256` of the
 * FULL original: a reviewer can prove what was cut without storing it.
 */
import { createHash } from 'node:crypto';

/** Matches `trace.maxFieldBytes` default in the config schema. */
const DEFAULT_MAX_FIELD_BYTES = 16_384;

export interface TruncateResult {
  text: string;
  truncated: boolean;
  /** Hash of the full original value, never of the cut preview. */
  sha256: string;
  /** Byte length of the full original value. */
  bytes: number;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function truncateText(value: string, maxBytes = DEFAULT_MAX_FIELD_BYTES): TruncateResult {
  const bytes = Buffer.byteLength(value, 'utf8');
  const sha256 = sha256Hex(value);
  if (bytes <= maxBytes) return { text: value, truncated: false, sha256, bytes };
  const encoded = Buffer.from(value, 'utf8');
  const end = charSafeEnd(encoded, Math.min(maxBytes, encoded.length));
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true, sha256, bytes };
}

/**
 * Non-strings are previewed as JSON, but an un-cut value is returned untouched
 * so `argsPreview` keeps its structured shape for the approval renderer.
 */
export function truncateValue(
  value: unknown,
  maxBytes = DEFAULT_MAX_FIELD_BYTES,
): { value: unknown; truncated: boolean; sha256: string } {
  const text = typeof value === 'string' ? value : stringifyForPreview(value);
  const result = truncateText(text, maxBytes);
  if (!result.truncated) return { value, truncated: false, sha256: result.sha256 };
  return { value: result.text, truncated: true, sha256: result.sha256 };
}

/**
 * Backs the cut off so a multi-byte character is never split: splitting one
 * would put U+FFFD into the trace and change the byte count we report.
 */
function charSafeEnd(buf: Buffer, cut: number): number {
  if (cut <= 0) return 0;
  let start = cut - 1;
  while (start > 0 && isContinuation(byteAt(buf, start))) start--;
  return start + sequenceLength(byteAt(buf, start)) <= cut ? cut : start;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead < 0xc0) return 1;
  if (lead < 0xe0) return 2;
  if (lead < 0xf0) return 3;
  return 4;
}

function byteAt(buf: Buffer, index: number): number {
  return buf[index] ?? 0;
}

function stringifyForPreview(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
