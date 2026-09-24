/** Fenced code block helpers. Pure. */

interface Point {
  offset?: number;
}

export interface FencePosition {
  start: Point;
  end: Point;
}

/** Drop indentation and blockquote markers so fences inside lists/quotes still match. */
function strip(line: string): string {
  return line.replace(/^[\s>]*/, '');
}

/**
 * Whether the fenced block at `position` (offsets into `markdown`) has its closing fence.
 * While streaming, the last block of the answer may be unclosed. Unknown positions and
 * non-fenced (indented) code count as closed.
 */
export function isFenceClosed(markdown: string, position: FencePosition | undefined): boolean {
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (start === undefined || end === undefined) return true;
  const lines = markdown.slice(start, end).replace(/\s+$/, '').split('\n');
  const open = /^(`{3,}|~{3,})/.exec(strip(lines[0] ?? ''));
  if (!open?.[1]) return true;
  if (lines.length < 2) return false;
  const marker = open[1];
  const close = /^(`{3,}|~{3,})\s*$/.exec(strip(lines[lines.length - 1] ?? ''));
  return !!close?.[1] && close[1][0] === marker[0] && close[1].length >= marker.length;
}
