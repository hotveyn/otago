/**
 * Simulated citations for Lorem ipsum answers: footnotes in the forms of the
 * clickable-citations contract (`.claude/features/clickable-citations/contracts/citations.ts`
 * §2): `sources/<name>:<a>-<b>` (lines), `sources/<name>.pdf:<p>-<q> (<comment>)` (pages),
 * `files/<name>:<a>-<b>`, `<node id>/files/<name>:<a>-<b>` and `files/<image>` without a
 * range. The ref comes first, digits only, one ref per footnote, so the web parser resolves
 * them exactly like real answers. Pure: no I/O.
 */
import { loremWords, type Random } from './lorem';

/** What the numbers of a range mean; derived from the cited file name only. */
export type CiteUnit = 'page' | 'line' | 'none';

export interface CiteRef {
  /** Reference without a range: `sources/guide.pdf`, `files/draft.md`, `a/files/spec.txt`. */
  path: string;
  unit: CiteUnit;
  /** Pages (unit `page`) or lines (unit `line`) of the cited file; 0 when unknown. */
  max: number;
}

const int = (random: Random, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

const decoder = new TextDecoder();

/** Pages for `.pdf`; lines for `.md` and `.txt`; none for anything else (images). */
export function citeUnitOf(name: string): CiteUnit {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'page';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'line';
  return 'none';
}

/** `/Type /Page` objects (not `/Pages`); 0 when none is visible (compressed object streams). */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = decoder.decode(bytes);
  if (!text.startsWith('%PDF-')) return 0;
  return text.match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

/** Lines of a text file; a trailing newline does not count as a line. */
export function textLineCount(text: string): number {
  if (text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** A ref for `path` whose unit and page/line count come from the file's name and bytes. */
export function citeRefOf(path: string, name: string, bytes: Uint8Array): CiteRef {
  const unit = citeUnitOf(name);
  const max =
    unit === 'page'
      ? pdfPageCount(bytes)
      : unit === 'line'
        ? textLineCount(decoder.decode(bytes))
        : 0;
  return { path, unit, max };
}

/**
 * `:<start>-<end>` or `:<start>` inside `1..max` (`:1` when `max` is unknown); `''` for unit
 * `none`.
 */
export function pickRange(random: Random, max: number, unit: CiteUnit): string {
  if (unit === 'none') return '';
  if (max < 1) return ':1';
  const start = int(random, 1, max);
  const span = unit === 'page' ? int(random, 1, 3) : int(random, 1, 6);
  const end = Math.min(max, start + span - 1);
  return end > start ? `:${start}-${end}` : `:${start}`;
}

const FENCE_RE = /^(```|~~~)/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const SKIP_LINE_RE = /^(?:#|\[\^|>|\||!\[)/;

/** Offsets of the `.` ending a prose sentence (not in code, lists, headings, quotes, tables). */
function sentenceEnds(body: string): number[] {
  const ends: number[] = [];
  let inFence = false;
  let offset = 0;
  for (const line of body.split('\n')) {
    const fence = FENCE_RE.test(line);
    if (fence) inFence = !inFence;
    if (!inFence && !fence && !LIST_ITEM_RE.test(line) && !SKIP_LINE_RE.test(line)) {
      const scan = line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length));
      for (const match of scan.matchAll(/\.(?=\s|$)/g)) ends.push(offset + match.index);
    }
    offset += line.length + 1;
  }
  return ends;
}

/** Put `[^1]`…`[^count]` before the period of `count` prose sentences, in reading order. */
function insertChips(body: string, count: number, random: Random): string {
  const ends = sentenceEnds(body);
  const chip = (k: number) => `[^${k + 1}]`;
  if (ends.length === 0) {
    const chips = Array.from({ length: count }, (_, k) => chip(k)).join('');
    return `${body}\n\nLorem ipsum dolor sit amet${chips}.`;
  }
  const available = [...ends];
  const chosen: number[] = [];
  for (let k = 0; k < count; k++) {
    if (available.length === 0) {
      chosen.push(ends[ends.length - 1] ?? 0);
      continue;
    }
    chosen.push(available.splice(int(random, 0, available.length - 1), 1)[0] ?? 0);
  }
  chosen.sort((a, b) => a - b);
  const chipsAt = new Map<number, string>();
  for (const [k, at] of chosen.entries()) chipsAt.set(at, `${chipsAt.get(at) ?? ''}${chip(k)}`);
  let out = '';
  let last = 0;
  for (const at of [...chipsAt.keys()].sort((a, b) => a - b)) {
    out += body.slice(last, at) + chipsAt.get(at);
    last = at;
  }
  return out + body.slice(last);
}

/**
 * The answer with one chip per ref in its prose and the definitions appended after a blank
 * line. A comment (2–4 lorem words in parentheses) always follows a PDF ref, and about half of
 * the others. No refs → the answer unchanged.
 */
export function withCitations(answer: string, refs: readonly CiteRef[], random: Random): string {
  if (refs.length === 0) return answer;
  const definitions = refs.map((ref, k) => {
    const range = pickRange(random, ref.max, ref.unit);
    const commented = ref.unit === 'page' || random() < 0.5;
    const comment = commented ? ` (${loremWords(random, int(random, 2, 4)).join(' ')})` : '';
    return `[^${k + 1}]: ${ref.path}${range}${comment}`;
  });
  const body = insertChips(answer.replace(/\s+$/, ''), refs.length, random);
  return `${body}\n\n${definitions.join('\n')}`;
}
