/**
 * Pure counting logic, kept separate from the plugin entry so it can be unit
 * tested without loading the plugin API at all.
 */

/** Whitespace-delimited words; a leading BOM is not content. */
export function countWords(text) {
  const normalized = text.replace(/^\uFEFF/, '');
  const matches = normalized.split(/\s+/u).filter((token) => token.length > 0);
  return matches.length;
}

/** Newline-delimited lines; a single trailing newline does not add an empty line. */
export function countLines(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/(\r\n|\r|\n)$/u, '');
  if (normalized.length === 0) return 0;
  return normalized.split(/\r\n|\r|\n/u).length;
}

export function measure(text) {
  const source = typeof text === 'string' ? text : String(text ?? '');
  return {
    words: countWords(source),
    lines: countLines(source),
    characters: source.length,
    // `globalThis.Buffer`: see the note in mcp-echo-server/server.mjs.
    bytes: globalThis.Buffer.byteLength(source, 'utf8'),
  };
}
