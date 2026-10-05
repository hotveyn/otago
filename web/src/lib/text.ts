/**
 * Display text helpers that never split a user-perceived character (grapheme cluster).
 * Same rules as the server's `server/src/text.ts`. Never cut display text with `String#slice`.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme clusters of `s`, in order. */
export function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (part) => part.segment);
}

/**
 * First `max` graphemes of `s`; `s` itself when it fits. When something was cut, trailing
 * whitespace of the kept part is dropped and `ellipsis` is appended (unless the kept part
 * already ends with it, e.g. a server title that was cut before).
 */
export function truncateGraphemes(s: string, max: number, ellipsis = '…'): string {
  const parts = graphemes(s);
  if (parts.length <= max) return s;
  const kept = parts.slice(0, Math.max(0, max)).join('');
  if (!ellipsis) return kept;
  const trimmed = kept.trimEnd();
  return trimmed.endsWith(ellipsis) ? trimmed : `${trimmed}${ellipsis}`;
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
