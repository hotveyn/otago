/** Selected text → Markdown blockquote lines. Returns '' for whitespace-only input. */
export function toBlockquote(text: string): string {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.trimEnd());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  const kept: string[] = [];
  for (const line of lines.slice(start, end)) {
    if (line === '' && kept[kept.length - 1] === '') continue;
    kept.push(line);
  }
  return kept.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

/** Append `text` as a blockquote to the draft, separated by exactly one blank line. */
export function appendQuote(draft: string, text: string): string {
  const quote = toBlockquote(text);
  if (quote === '') return draft;
  if (draft.trim() === '') return `${quote}\n\n`;
  const separator = draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n';
  // The trailing blank line keeps the next typed text out of the blockquote.
  return `${draft}${separator}${quote}\n\n`;
}

export function isQuotable(text: string): boolean {
  return text.trim() !== '';
}
