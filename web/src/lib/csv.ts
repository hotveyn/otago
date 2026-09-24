/** CSV/TSV parsing and serialization (RFC 4180 quoting). Pure except `downloadText`. */

export interface ParsedTable {
  header: string[];
  rows: string[][];
  /** Some rows had a different column count and were padded or truncated. */
  ragged: boolean;
}

const CANDIDATES = [',', ';', '\t', '|'] as const;
const SAMPLE_LINES = 10;

/** Split into records honoring quotes. `limit` stops after that many records. */
function records(text: string, delimiter: string, limit = Number.POSITIVE_INFINITY): string[][] {
  const out: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let i = 0;
  const endRecord = () => {
    record.push(field);
    // Skip truly empty lines (no delimiter, no quotes).
    if (!(record.length === 1 && field === '' && !wasQuoted)) out.push(record);
    record = [];
    field = '';
    wasQuoted = false;
  };
  while (i < text.length && out.length < limit) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += char;
      }
      i += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      wasQuoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
    } else {
      field += char;
    }
    i += 1;
  }
  if (out.length < limit && (field !== '' || record.length > 0 || wasQuoted)) endRecord();
  return out;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Pick `,` `;` tab or `|` by the most consistent column count over the first lines. */
export function detectDelimiter(text: string): string {
  const source = stripBom(text);
  let best: { delimiter: string; score: number } = { delimiter: ',', score: 0 };
  for (const delimiter of CANDIDATES) {
    const sample = records(source, delimiter, SAMPLE_LINES);
    if (sample.length === 0) continue;
    const counts = sample.map((record) => record.length);
    const first = counts[0] ?? 1;
    if (first < 2) continue;
    const consistent = counts.filter((count) => count === first).length / counts.length;
    const score = consistent * 1000 + first;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/** Parse CSV/TSV text. Returns `null` when there is nothing usable. */
export function parseCsv(text: string, delimiter?: string): ParsedTable | null {
  const source = stripBom(text);
  if (source.trim() === '') return null;
  const all = records(source, delimiter ?? detectDelimiter(source));
  const [header, ...body] = all;
  if (!header || header.length === 0) return null;
  const width = header.length;
  let ragged = false;
  const rows = body.map((row) => {
    if (row.length === width) return row;
    ragged = true;
    return row.length > width
      ? row.slice(0, width)
      : [...row, ...Array<string>(width - row.length).fill('')];
  });
  return { header, rows, ragged };
}

function quote(cell: string, delimiter: string): string {
  if (
    cell.includes(delimiter) ||
    cell.includes('"') ||
    cell.includes('\n') ||
    cell.includes('\r') ||
    cell !== cell.trim()
  )
    return `"${cell.replaceAll('"', '""')}"`;
  return cell;
}

/** Serialize with RFC 4180 quoting and CRLF line endings. */
export function toCsv(header: string[], rows: string[][], delimiter = ','): string {
  const line = (cells: string[]) =>
    cells.length === 1 && cells[0] === ''
      ? '""'
      : cells.map((cell) => quote(cell, delimiter)).join(delimiter);
  return [header, ...rows].map(line).join('\r\n');
}

/** Save text as a file via a temporary `<a download>`. */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
