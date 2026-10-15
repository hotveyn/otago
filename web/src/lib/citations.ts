import { i18n } from '../i18n';
import { ebookExtensionOf, viewableFile } from './sources';

/** What the numbers of a cited range mean; derived from the cited file name only. */
export type CitationUnit = 'page' | 'line' | 'none';

export interface CitedRange {
  /** First page (unit `page`) or first line (unit `line`), ≥ 1. Absent = no position. */
  start?: number;
  /** Last page/line, ≥ start; `:a` alone yields `end = start`. */
  end?: number;
}

/** Reserved for text-fragment / quote highlighting (feature seams); never produced today. */
interface FutureSeams {
  quote?: never;
  fragment?: never;
}

export type CitationTarget =
  /** `sources/<file>` (exact stored name, NFC, percent-decoded). */
  | ({ kind: 'source'; file: string; comment?: string } & CitedRange & FutureSeams)
  /** `[<node>/]files/<name>`; `node` undefined = the answer's own node. */
  | ({ kind: 'file'; node?: string; name: string; comment?: string } & CitedRange & FutureSeams)
  /** `title` = link label (`[label](url)`) or the non-URL text of the footnote. */
  | { kind: 'url'; url: string; title?: string; comment?: string }
  /** Anything that did not parse. */
  | { kind: 'text'; text: string };

export type FileTarget = Extract<CitationTarget, { kind: 'source' | 'file' }>;

export interface Citation {
  /** Footnote label as written by the model, e.g. `1` or `book`. */
  key: string;
  /** Display number, in order of first reference. */
  number: number;
  target: CitationTarget;
}

// Reference grammar; mirrors contracts/citations.ts (clickable-citations). A ref without a
// range ends at the first known extension followed by REF_BOUNDARY; a range ends at its last
// digit and must be followed by RANGE_BOUNDARY (`.` allowed: a digit never continues a name).
const REF_BOUNDARY = String.raw`(?=$|[\s)\]>\x60,;:])`;
const RANGE_BOUNDARY = String.raw`(?=$|[\s)\]>\x60.,;:])`;
const RANGE = String.raw`(?::(\d+)(?:\s*[-–]\s*(\d+))?${RANGE_BOUNDARY}|${REF_BOUNDARY})`;
const KNOWN_EXT = String.raw`\.(?:md|txt|pdf|epub|fb2(?:\.zip)?|mobi|azw3?)`;
const SOURCE_CHARS = String.raw`[\p{L}\p{M}\p{Nd}._ ,()'’+&-]`;
const USER_FILE_NAME = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const NODE_SEGMENT_SOURCE = String.raw`[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*`;
/** `sources/<name>[:a[-b]]` at the start. Groups: 1 name, 2 start, 3 end. */
const SOURCE_REF_RE = new RegExp(
  String.raw`^(?:\./)?sources/(${SOURCE_CHARS}+?${KNOWN_EXT})${RANGE}`,
  'iu',
);
/** `[<node id>/]files/<name>[:a[-b]]` at the start. Groups: 1 node id, 2 name, 3 start, 4 end. */
const FILE_REF_RE = new RegExp(
  String.raw`^(?:\./)?(?:(${NODE_SEGMENT_SOURCE}(?:/${NODE_SEGMENT_SOURCE})*)/)?files/(${USER_FILE_NAME})${RANGE}`,
  'u',
);
/** Stored source names (contracts/shared.ts SOURCE_NAME_RE): no `..`, no leading dot. */
const SOURCE_NAME_RE = /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}._ ,()'’+&-]{0,199}$/u;

const BACKTICK_RE = /^`([^`]+)`(.*)$/s;
const MD_LINK_RE = /^\[([^\]]*)\]\((\S+?)\)(.*)$/s;
const ANGLE_RE = /^<([^>]+)>$/;
const URL_RE = /https?:\/\/[^\s<>)\]]+/;
const DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const REFERENCE_RE = /\[\^([^\]\s]+)\](?!:)/g;
const INLINE_SOURCE_RE =
  /(?<![\w/[(])((?:\.\/)?sources\/[\p{L}\p{M}\p{Nd}_.,()'’+& -]+?\.(?:md|txt|pdf):\d+(?:\s*[-–]\s*\d+)?)/gu;

function rangeOf(start: string | undefined, end: string | undefined): CitedRange | null {
  if (start === undefined) return { start: undefined, end: undefined };
  const from = Number(start);
  if (from < 1) return null;
  const to = end === undefined ? from : Math.max(from, Number(end));
  return { start: from, end: to };
}

/**
 * A `sources/…` or `[node/]files/…` ref at the START of `text`, plus the text after it.
 * Names and node ids are NFC. Null when nothing matches or the range starts at 0.
 */
export function parseRef(text: string): { target: FileTarget; rest: string } | null {
  const source = SOURCE_REF_RE.exec(text);
  if (source) {
    const file = (source[1] ?? '').normalize('NFC');
    const range = rangeOf(source[2], source[3]);
    if (!range || !SOURCE_NAME_RE.test(file) || file.includes('..')) return null;
    return { target: { kind: 'source', file, ...range }, rest: text.slice(source[0].length) };
  }
  const file = FILE_REF_RE.exec(text);
  if (file) {
    const range = rangeOf(file[3], file[4]);
    if (!range) return null;
    return {
      target: {
        kind: 'file',
        node: file[1]?.normalize('NFC'),
        name: (file[2] ?? '').normalize('NFC'),
        ...range,
      },
      rest: text.slice(file[0].length),
    };
  }
  return null;
}

/** A whole string that is exactly one file ref (already percent-decoded), or null. */
export function parseWholeRef(ref: string): FileTarget | null {
  const parsed = parseRef(ref.trim());
  return parsed && parsed.rest.trim() === '' ? parsed.target : null;
}

/** `sources/<file>:<start>-<end>` (decoded) → parts, or null. */
export function parseSourceRef(ref: string): Extract<CitationTarget, { kind: 'source' }> | null {
  const target = parseWholeRef(ref);
  return target?.kind === 'source' ? target : null;
}

/** Whether `(` at index 0 closes at the last index (one enclosing pair). */
function wrappedInParens(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/** The free text after a ref: one leading separator and one enclosing `(…)` pair dropped. */
export function extractComment(rest: string): string | undefined {
  let s = rest.trim().replace(/^[—–\-:,;]\s*/, '');
  if (wrappedInParens(s)) s = s.slice(1, -1).trim();
  return s === '' ? undefined : s;
}

function withComment<T extends FileTarget>(target: T, rest: string): T {
  const comment = extractComment(rest);
  return comment === undefined ? target : { ...target, comment };
}

function refWithComment(inner: string, rest: string): FileTarget | null {
  const parsed = parseRef(inner.trim());
  if (parsed?.rest.trim() !== '') return null;
  return withComment(parsed.target, rest);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseCitationTarget(raw: string): CitationTarget {
  const trimmed = raw.trim();
  // Agents end sentences with periods: one trailing `.`, `,` or `;` is not part of the ref.
  let text = trimmed.replace(/[.,;]$/, '');

  const code = BACKTICK_RE.exec(text);
  if (code) {
    const target = refWithComment(code[1] ?? '', code[2] ?? '');
    if (target) return target;
  }

  const link = MD_LINK_RE.exec(text);
  if (link?.[2]) {
    const destination = safeDecode(link[2]);
    const target = refWithComment(destination, link[3] ?? '');
    if (target) return target;
    if (/^https?:\/\//.test(destination)) {
      const comment = extractComment(link[3] ?? '');
      return {
        kind: 'url',
        url: link[2],
        title: link[1] || undefined,
        ...(comment === undefined ? {} : { comment }),
      };
    }
  }

  const angle = ANGLE_RE.exec(text);
  if (angle) {
    const inner = (angle[1] ?? '').trim();
    const target = parseWholeRef(inner);
    if (target) return target;
    text = inner;
  }

  const plain = parseRef(text);
  if (plain) return withComment(plain.target, plain.rest);

  const url = URL_RE.exec(text);
  if (url) {
    const title = text
      .replace(url[0], '')
      .replace(/[\s:–—-]+$|^[\s:–—-]+/g, '')
      .trim();
    return { kind: 'url', url: url[0], title: title || undefined };
  }
  return { kind: 'text', text: trimmed };
}

/** Split markdown into prose and code (fenced blocks, inline code) so rewrites skip code. */
function mapProse(markdown: string, fn: (prose: string) => string): string {
  const parts = markdown.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:```|~~~)[^\n]*$|(?![\s\S])))/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(/(`[^`\n]+`)/)
        .map((piece, j) => (j % 2 === 1 ? piece : fn(piece)))
        .join('');
    })
    .join('');
}

/** Percent-encode the characters that would end or break a Markdown link destination. */
function linkHref(ref: string): string {
  return ref.replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export const CITE_HREF_PREFIX = '#cite-';

/**
 * Pull footnote definitions out of an answer and rewrite references into `[n](#cite-key)` links,
 * so the renderer can show them as citation chips plus a source list.
 */
export function extractCitations(markdown: string): { body: string; citations: Citation[] } {
  const definitions = new Map<string, string>();
  const lines = markdown.split('\n');
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : DEFINITION_RE.exec(line);
    if (match?.[1]) definitions.set(match[1], match[2] ?? '');
    else kept.push(line);
  }

  const citations = new Map<string, Citation>();
  const citationFor = (key: string): Citation | undefined => {
    const existing = citations.get(key);
    if (existing) return existing;
    const raw = definitions.get(key);
    if (raw === undefined) return undefined;
    const citation = { key, number: citations.size + 1, target: parseCitationTarget(raw) };
    citations.set(key, citation);
    return citation;
  };

  const body = mapProse(kept.join('\n').replace(/\s+$/, ''), (prose) =>
    prose
      .replace(REFERENCE_RE, (whole, key: string) => {
        const citation = citationFor(key);
        return citation
          ? `[${citation.number}](${CITE_HREF_PREFIX}${encodeURIComponent(key)})`
          : whole;
      })
      .replace(INLINE_SOURCE_RE, (ref: string) => `[${ref}](${linkHref(ref)})`),
  );
  for (const key of definitions.keys()) citationFor(key);
  return { body, citations: [...citations.values()] };
}

/** Pages for `.pdf`; lines for `.md`, `.txt` and e-books (their text companion); else none. */
export function unitOf(name: string): CitationUnit {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'page';
  if (lower.endsWith('.md') || lower.endsWith('.txt') || ebookExtensionOf(lower)) return 'line';
  return 'none';
}

/** The file a `line` target opens: an e-book binary maps to its `.md` companion. */
export function viewableName(name: string): string {
  return viewableFile(name);
}

/** `pages 5–12` / `page 3` / `lines 1–4` / `line 7`; undefined without a position or unit. */
export function describeRange(name: string, start?: number, end?: number): string | undefined {
  const unit = unitOf(name);
  if (unit === 'none' || start === undefined) return undefined;
  const last = end ?? start;
  const key =
    unit === 'page' ? (last !== start ? 'pages' : 'page') : last !== start ? 'lines' : 'line';
  return i18n.t(key, { start, end: last });
}

/** Display file name of a file target. */
export function labelOf(target: FileTarget): string {
  return target.kind === 'source' ? target.file : target.name;
}

function pathOfTarget(target: FileTarget): string {
  if (target.kind === 'source') return target.file;
  return `${target.node === undefined ? '' : `${target.node}/`}files/${target.name}`;
}

export function describeTarget(target: CitationTarget): string {
  switch (target.kind) {
    case 'source':
    case 'file': {
      const range = describeRange(labelOf(target), target.start, target.end);
      const head =
        range === undefined ? pathOfTarget(target) : `${pathOfTarget(target)} · ${range}`;
      return target.comment === undefined ? head : `${head} — ${target.comment}`;
    }
    case 'url':
      return target.title ?? target.url;
    case 'text':
      return target.text;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** URL without scheme and host, for compact display. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname + parsed.search).replace(/\/$/, '');
    return path || parsed.hostname;
  } catch {
    return url;
  }
}
