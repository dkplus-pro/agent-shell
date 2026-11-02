import { describe, expect, it } from 'vitest';
import { sha256Hex, truncateText, truncateValue } from '../../src/events/truncate.js';

describe('truncateText', () => {
  it('hashes with sha256 over utf-8 input', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('leaves a value under the byte cap untouched', () => {
    const result = truncateText('hello world', 64);
    expect(result).toEqual({
      text: 'hello world',
      truncated: false,
      sha256: sha256Hex('hello world'),
      bytes: 11,
    });
  });

  it('keeps the hash of the full original when truncating', () => {
    const original = 'x'.repeat(500);
    const result = truncateText(original, 128);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(500);
    expect(result.text).toBe('x'.repeat(128));
    expect(result.sha256).toBe(sha256Hex(original));
    expect(result.sha256).not.toBe(sha256Hex(result.text));
  });

  it('never splits a multi-byte character', () => {
    const value = `aaa${'🙂'.repeat(5)}`;
    expect(Buffer.byteLength(value, 'utf8')).toBe(23);

    const cutAt3 = truncateText(value, 6);
    expect(cutAt3.text).toBe('aaa');
    expect(Buffer.byteLength(cutAt3.text, 'utf8')).toBeLessThanOrEqual(6);

    const cutAt7 = truncateText(value, 7);
    expect(cutAt7.text).toBe('aaa🙂');
    expect(cutAt7.text).not.toContain('\uFFFD');
    expect(cutAt7.sha256).toBe(sha256Hex(value));
  });

  it('never splits 2-byte or 3-byte sequences either', () => {
    const twoByte = truncateText('é'.repeat(4), 3);
    expect(twoByte.text).toBe('é');
    expect(Buffer.byteLength(twoByte.text, 'utf8')).toBe(2);

    const threeByte = truncateText('中文文字', 4);
    expect(threeByte.text).toBe('中');
    expect(threeByte.sha256).toBe(sha256Hex('中文文字'));
  });

  it('defaults to the 16 KB preview budget from docs/03 §9', () => {
    const long = 'y'.repeat(20_000);
    const result = truncateText(long);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(16_384);
    expect(result.sha256).toBe(sha256Hex(long));
  });

  it('yields an empty preview when the budget is zero', () => {
    const result = truncateText('🙂🙂', 0);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(8);
  });
});

describe('truncateValue', () => {
  it('returns non-strings unchanged while still hashing them', () => {
    const args = { path: 'notes/a.md', content: 'short' };
    const result = truncateValue(args, 1024);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(args);
    expect(result.sha256).toBe(sha256Hex(JSON.stringify(args)));
  });

  it('replaces an oversized object with a truncated JSON preview', () => {
    const args = { path: 'notes/a.md', content: 'z'.repeat(2000) };
    const result = truncateValue(args, 128);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    const text = result.value as string;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(128);
    expect(text.startsWith('{"path":"notes/a.md"')).toBe(true);
    expect(result.sha256).toBe(sha256Hex(JSON.stringify(args)));
  });

  it('survives a circular structure instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    const result = truncateValue(cyclic, 1024);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(cyclic);
    expect(result.sha256).toBe(sha256Hex('[object Object]'));
  });

  it('treats undefined as its textual preview', () => {
    const result = truncateValue(undefined, 1024);
    expect(result.truncated).toBe(false);
    expect(result.sha256).toBe(sha256Hex('undefined'));
  });
});
