/** Sorting and filtering over string cells. Pure. */

export type SortDirection = 'asc' | 'desc';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `12`, `-3`, `1,234.5`, `12%`, `.5` -> number; anything else -> null. */
export function parseNumeric(cell: string): number | null {
  let text = cell.trim();
  if (text === '') return null;
  if (text.endsWith('%')) text = text.slice(0, -1).trim();
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Numeric-aware comparison; empty cells sort after everything. */
export function compareCells(a: string, b: string): number {
  const emptyA = a.trim() === '';
  const emptyB = b.trim() === '';
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const numA = parseNumeric(a);
  const numB = parseNumeric(b);
  if (numA !== null && numB !== null) return numA - numB;
  if (numA !== null) return -1;
  if (numB !== null) return 1;
  return collator.compare(a, b);
}

/** Stable sort; returns row indices. Empty cells stay last in both directions. */
export function sortRows(rows: string[][], column: number, direction: SortDirection): number[] {
  const sign = direction === 'asc' ? 1 : -1;
  return rows
    .map((_, index) => index)
    .sort((x, y) => {
      const a = rows[x]?.[column] ?? '';
      const b = rows[y]?.[column] ?? '';
      const emptyA = a.trim() === '';
      const emptyB = b.trim() === '';
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      return sign * compareCells(a, b) || x - y;
    });
}

/**
 * Case-insensitive substring match over any cell; whitespace-separated terms are ANDed
 * (each term may match a different cell). Returns matching row indices in input order.
 */
export function filterRows(rows: string[][], query: string): number[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const indices = rows.map((_, index) => index);
  if (terms.length === 0) return indices;
  return indices.filter((index) => {
    const haystack = (rows[index] ?? []).join('\u0000').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
