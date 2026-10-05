/** Text helpers that never split a user-perceived character (grapheme cluster). */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme clusters of `s`, in order. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (part) => part.segment);
}

/**
 * First `max` graphemes of `s`. When something was cut, trailing whitespace of the kept part is
 * dropped and `ellipsis` is appended. Never cuts inside a grapheme (no `String#slice`).
 */
export function truncateGraphemes(s: string, max: number, ellipsis = ''): string {
  const parts = graphemes(s);
  if (parts.length <= max) return s;
  const kept = parts.slice(0, Math.max(0, max)).join('');
  return ellipsis ? `${kept.trimEnd()}${ellipsis}` : kept;
}

// TextEncoder instead of Buffer: node-names.ts (which uses this) is also bundled by demo/.
const utf8Encoder = new TextEncoder();

/** Length of `s` in UTF-8 bytes. */
export function utf8Length(s: string): number {
  return utf8Encoder.encode(s).length;
}

/** First non-empty line of `s`, trimmed (`""` when there is none). */
export function firstLine(s: string): string {
  for (const line of s.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Runs of whitespace → one space, trimmed. */
export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
