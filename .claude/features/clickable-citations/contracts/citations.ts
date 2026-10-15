/**
 * CONTRACT SPEC (planning artifact) — feature `clickable-citations`. Owner: server.
 * The citation grammar: what the agent is told to write (./prompt.ts) and what the web parses
 * (`web/src/lib/citations.ts`). The demo bundles the web parser, so it needs no copy.
 *
 * The regexes below are the NORMATIVE grammar. The web may implement them with its own
 * regexes/parser as long as the conformance table at the end holds (web tests MUST include
 * every row of CONFORMANCE as a test case).
 */
import {
  EBOOK_EXTENSIONS,
  EBOOK_TEXT_SUFFIX,
  type NodeId,
  NODE_SEGMENT_SOURCE,
  PDF_EXTENSION,
  TEXT_SOURCE_EXTENSIONS,
} from './shared';

/* ---------------------------------------------------------------------------------------
 * 1. Footnotes (unchanged Markdown syntax)
 *
 *   body:        … claim [^k] …
 *   definition:  [^k]: <footnote text>            (one line; k = label, no spaces)
 *
 * The footnote text is ONE of (`ref` = ./§2; `comment` = ./§4):
 *   F1  <ref>
 *   F2  <ref> <comment>                           e.g. `sources/a.pdf:1-4 (cover page)`
 *   F3  `<ref>`                                   backtick-wrapped ref
 *   F4  `<ref>` <comment>                         e.g. `` `sources/a.pdf:1-4` — cover ``
 *   F5  <<ref>>                                   angle-wrapped (URLs and file refs)
 *   F6  [<label>](<ref>)                          Markdown link; <label> is ignored for file
 *                                                 refs and becomes `title` for URL refs
 *   F7  [<label>](<ref>) <comment>
 *   F8  <url>                                     bare URL (existing behaviour, unchanged)
 *   F9  <text with a URL somewhere>               existing behaviour: `url` + the rest as
 *                                                 `title` (unchanged)
 *   F10 anything else                             `text`
 * In F6/F7 the link destination is percent-decoded before matching (`decodeURIComponent`,
 * falling back to the raw string if decoding throws). In F3/F4 the wrapper is a single pair
 * of backticks on the ref only. Whitespace before/after the footnote text is ignored. A single
 * trailing `.`, `,` or `;` at the very end of the footnote text is stripped before matching
 * (agents end sentences with periods).
 *
 * A ref that is not at the start of the footnote text (after the optional wrapper) is NOT a
 * ref: the whole footnote stays `text` (F10). This is the deliberate "ref first" rule.
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * 2. Reference grammar
 *
 *   ref        = source-ref | file-ref | url
 *   source-ref = ["./"] "sources/" source-name [ range ]
 *   file-ref   = ["./"] [ node-id "/" ] "files/" user-file-name [ range ]
 *   range      = ":" int [ ws* ("-" | "–") ws* int ]        ints are decimal, ≥ 1
 *   url        = "http://" … | "https://" …                   (existing URL_RE; unchanged)
 *
 *   source-name    = (shared.ts SOURCE_NAME_RE alphabet) ending with a KNOWN EXTENSION
 *   user-file-name = shared.ts USER_FILE_NAME_RE (ASCII, no spaces)
 *   node-id        = shared.ts NODE_ID_RE (segments joined by "/")
 *
 * Delimiting the ref from the comment:
 *  - a range ends at the last digit; the ref then MUST be followed by RANGE_BOUNDARY (end of
 *    text, whitespace, `)` `]` `>` `` ` `` `.` `,` `;` `:`);
 *  - without a range, a `sources/` name may contain spaces and parentheses, so the name ends
 *    at the FIRST known extension that is followed by a range or REF_BOUNDARY (lazy match;
 *    REF_BOUNDARY = RANGE_BOUNDARY minus `.`). Thus
 *    `sources/my notes v2.md intro` → file `my notes v2.md`, comment `intro`;
 *    `sources/a.md.txt:3` → file `a.md.txt` (the `.md` is followed by `.`, not a boundary);
 *    `sources/a.pdf: see p. 3` → file `a.pdf` (no range), comment `see p. 3`;
 *  - a `files/` name has no spaces: it ends at the first character outside its alphabet; it
 *    must end with a letter/digit (stored names always do), so `files/report.pdf.` → name
 *    `report.pdf` (REF_BOUNDARY is checked after that letter/digit).
 *
 * Known extensions (case-insensitive) that may END a `sources/` name without a range:
 *   .md .txt .pdf .epub .fb2 .fb2.zip .mobi .azw .azw3   (and `.epub.md` etc. via `.md`)
 * A `sources/` ref whose name does not end with one of them does not parse (→ `text`).
 * `files/` names are not restricted by extension in the grammar (images are legal user files).
 * ------------------------------------------------------------------------------------- */

/**
 * What may follow a ref WITHOUT a range (lookahead): end of text, whitespace, `)` `]` `>`
 * `` ` ``, and `,` `;` `:` (a name never contains `:`; `,`/`;` directly before a comment are
 * accepted). NOT `.`: a dot continues a name (`a.md.txt`).
 */
export const REF_BOUNDARY = String.raw`(?=$|[\s)\]>\x60,;:])`;
/** What may follow a RANGE: as above plus `.` (a digit never continues into a name). */
export const RANGE_BOUNDARY = String.raw`(?=$|[\s)\]>\x60.,;:])`;

/** Optional range with its boundary, or the no-range boundary. Groups: start, end. */
const RANGE = String.raw`(?::(\d+)(?:\s*[-–]\s*(\d+))?${RANGE_BOUNDARY}|${REF_BOUNDARY})`;
const KNOWN_EXT = String.raw`\.(?:md|txt|pdf|epub|fb2(?:\.zip)?|mobi|azw3?)`;
const SOURCE_CHARS = String.raw`[\p{L}\p{M}\p{Nd}._ ,()'’+&-]`;
const USER_FILE_NAME = String.raw`[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?`;

/**
 * `sources/<name>[:a[-b]]` at the START of a string. Groups: 1 name, 2 start, 3 end.
 * Flags `iu`: extensions are case-insensitive; names are Unicode.
 */
export const SOURCE_REF_RE = new RegExp(
  String.raw`^(?:\./)?sources/(${SOURCE_CHARS}+?${KNOWN_EXT})${RANGE}`,
  'iu',
);

/**
 * `[<node id>/]files/<name>[:a[-b]]` at the START of a string.
 * Groups: 1 node id (undefined = the answer's own node), 2 name, 3 start, 4 end.
 */
export const FILE_REF_RE = new RegExp(
  String.raw`^(?:\./)?(?:(${NODE_SEGMENT_SOURCE}(?:/${NODE_SEGMENT_SOURCE})*)/)?files/(${USER_FILE_NAME})${RANGE}`,
  'u',
);

/** Existing URL detection (`web/src/lib/citations.ts` URL_RE), unchanged. */
export const URL_RE = /https?:\/\/[^\s<>)\]]+/;

/* ---------------------------------------------------------------------------------------
 * 3. Units: what the numbers in a range mean. Derived from the cited NAME only.
 * ------------------------------------------------------------------------------------- */

export type CitationUnit =
  /** `.pdf`: 1-based PDF pages. `start` = first cited page. */
  | 'page'
  /** `.md`, `.txt`, e-book text companions, e-book binaries (→ companion): 1-based lines. */
  | 'line'
  /** Anything else (images, unknown): a range is ignored; the file is opened as is. */
  | 'none';

/**
 * Normative mapping (case-insensitive on the extension):
 *   name ends with `.pdf`                        → 'page'
 *   name ends with `.md` or `.txt`               → 'line'   (includes `book.epub.md`)
 *   name ends with an EBOOK_EXTENSIONS member    → 'line'   (resolves to `<name>.md`)
 *   otherwise                                    → 'none'
 */
export type UnitOf = (name: string) => CitationUnit;
export const UNIT_RULES = { page: [PDF_EXTENSION], line: [...TEXT_SOURCE_EXTENSIONS, ...EBOOK_EXTENSIONS] };

/**
 * Name of the file the client actually opens for a `line` target: an e-book binary maps to
 * its companion (`book.epub` → `book.epub.md`, `EBOOK_TEXT_SUFFIX`); everything else is
 * itself. Same rule for `sources/` and `files/` (user e-books have a companion too, served by
 * the same `/files` route; `UserFileInfo.text` names it).
 */
export type ViewableName = (name: string) => string;
export const VIEWABLE_SUFFIX = EBOOK_TEXT_SUFFIX;

/* ---------------------------------------------------------------------------------------
 * 4. Comment: the free text after the ref (F2, F4, F7).
 *   comment = remainder after the ref (and after the closing wrapper)
 *     → trim
 *     → strip ONE leading separator among `—` `–` `-` `:` `,` `;` then trim
 *     → if the whole remainder is wrapped in one pair of `(` `)`, strip the pair and trim
 *     → empty → no comment (undefined)
 *   The comment is display-only: shown muted next to the link in the source list and used as
 *   the chip tooltip (feature.md default). It is never interpreted (no second ref inside it).
 *   Rendering: plain text (no Markdown), cut by graphemes if truncated, `dir="auto"`.
 * ------------------------------------------------------------------------------------- */
export const COMMENT_LEADING_SEPARATORS = ['—', '–', '-', ':', ',', ';'] as const;

/* ---------------------------------------------------------------------------------------
 * 5. Target model (recommended shape for `web/src/lib/citations.ts`; the web owns the final
 *    TypeScript, but field NAMES and semantics below are binding so demo/web tests agree).
 * ------------------------------------------------------------------------------------- */

export interface CitedRange {
  /** First page (unit `page`) or first line (unit `line`), ≥ 1. Absent = no position. */
  start?: number;
  /**
   * Last page/line, ≥ start. Absent in the parsed form when the ref had no range; a ref
   * `:a` (no `-b`) yields `end = start`. If the agent wrote `end < start`, treat as `start`.
   */
  end?: number;
}

export type CitationTarget =
  /** `sources/<file>` (file = exact stored name, NFC, percent-decoded). */
  | ({ kind: 'source'; file: string; comment?: string } & CitedRange & FutureSeams)
  /**
   * `[<node>/]files/<name>`. `node` undefined = the answer's own node (resolved by the
   * renderer from the saved node id; unresolvable while the answer streams).
   */
  | ({ kind: 'file'; node?: NodeId; name: string; comment?: string } & CitedRange & FutureSeams)
  /** Existing. `title` = link label (F6/F7) or the non-URL text of F9. */
  | { kind: 'url'; url: string; title?: string; comment?: string }
  /** Existing. Anything that did not parse. */
  | { kind: 'text'; text: string };

/** Reserved fields (feature.md "Future considerations"); never produced in v1. */
export interface FutureSeams {
  /** A quoted passage to highlight inside the file (text or PDF). */
  quote?: never;
  /** A URL text fragment (`#:~:text=`) for `url` targets. */
  fragment?: never;
}

export interface Citation {
  /** Footnote label as written by the model, e.g. `1` or `book`. Unchanged. */
  key: string;
  /** Display number, in order of first reference. Unchanged. */
  number: number;
  target: CitationTarget;
}

/* ---------------------------------------------------------------------------------------
 * 6. Opening a target ("open target" logic lives in ONE place in the web, feature.md).
 *
 *   inputs: tree id, the answer's node id (undefined while streaming), the target
 *
 *   url                       → new tab (unchanged: `window.open(url, '_blank', 'noopener,
 *                               noreferrer')` or anchor `target=_blank`)
 *   source / file, unit page  → new tab: `<file url>` + (`start` ? `#page=<start>` : '')
 *   source / file, unit line  → in-app text viewer on `viewable(name)` with `start`/`end`
 *                               (scroll `start` into view, highlight `start..end`; no range →
 *                               unscrolled, no highlight). Existing SourceViewer behaviour;
 *                               a user-file variant fetches the `/files` route instead.
 *   source / file, unit none  → new tab: `<file url>` (inline; images render natively)
 *   file with node undefined and no saved node id → no action; render as inert text
 *   text                      → no action
 *
 *   <file url> = sourceUrl(tree, file) | userFileUrl(tree, node ?? ownNodeId, name)
 *                (./file-routes.ts; always with NFC-normalized ids and names).
 *
 *   New tabs MUST be opened synchronously inside the click handler (or be real anchors with
 *   `href` precomputed and `target="_blank" rel="noopener noreferrer"`): never after an
 *   `await` (pop-up blockers). The `#page=` fragment is honoured by Chromium/Edge/Firefox
 *   viewers; Safari ignores it (opens page 1) — accepted.
 *
 *   Labels: `page`/`pages a–b` for unit page, `line`/`lines a–b` for unit line, in the
 *   source list row, the chip tooltip and the viewer header (both locales).
 * ------------------------------------------------------------------------------------- */

export type OpenAction =
  | { kind: 'new-tab'; url: string }
  | { kind: 'viewer'; where: 'source' | 'file'; node?: NodeId; name: string; start?: number; end?: number }
  | { kind: 'none' };

/** Fragment appended to a PDF URL when a page is cited. */
export const PDF_PAGE_FRAGMENT = (page: number) => `#page=${page}`;

/* ---------------------------------------------------------------------------------------
 * 7. Conformance table. `in` = full footnote text (after `[^k]: `). `out` = expected target
 *    (only the fields that matter). The web test suite MUST contain every row.
 * ------------------------------------------------------------------------------------- */
export const CONFORMANCE: ReadonlyArray<{ in: string; out: Partial<CitationTarget> & { kind: string } }> = [
  // F1: plain refs (existing behaviour kept)
  { in: 'sources/the-book-ch4.md:120-134', out: { kind: 'source', file: 'the-book-ch4.md', start: 120, end: 134 } },
  { in: 'sources/notes.md:7', out: { kind: 'source', file: 'notes.md', start: 7, end: 7 } },
  { in: './sources/notes.txt:3 – 5', out: { kind: 'source', file: 'notes.txt', start: 3, end: 5 } },
  { in: 'sources/paper.pdf', out: { kind: 'source', file: 'paper.pdf', start: undefined, end: undefined } },
  { in: 'sources/paper.pdf:5-12', out: { kind: 'source', file: 'paper.pdf', start: 5, end: 12 } },
  // Unicode names with spaces/parentheses (needs the uncommitted source-names change)
  {
    in: 'sources/Высоконагруженные приложения (Клеппман).pdf:1-4',
    out: { kind: 'source', file: 'Высоконагруженные приложения (Клеппман).pdf', start: 1, end: 4 },
  },
  { in: 'sources/my notes v2.md intro', out: { kind: 'source', file: 'my notes v2.md', comment: 'intro' } },
  { in: 'sources/a.md.txt:3', out: { kind: 'source', file: 'a.md.txt', start: 3, end: 3 } },
  // F2: ref + comment (the screenshot case)
  {
    in: 'sources/desiging-data-intesive-applications.pdf:1-4 (страницы PDF: обложка и выходные данные)',
    out: {
      kind: 'source',
      file: 'desiging-data-intesive-applications.pdf',
      start: 1,
      end: 4,
      comment: 'страницы PDF: обложка и выходные данные',
    },
  },
  { in: 'sources/a.pdf:1-4 — cover', out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' } },
  { in: 'sources/a.pdf:1-4, cover.', out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' } },
  // F3/F4: backticks
  { in: '`sources/a.pdf:1-4`', out: { kind: 'source', file: 'a.pdf', start: 1, end: 4 } },
  { in: '`sources/a.pdf:1-4` — cover', out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' } },
  // F5: angle brackets
  { in: '<sources/a.md:2-3>', out: { kind: 'source', file: 'a.md', start: 2, end: 3 } },
  // F6/F7: Markdown link (percent-encoded destination), label ignored for files
  { in: '[Kleppmann](sources/a%20b.pdf:1-4)', out: { kind: 'source', file: 'a b.pdf', start: 1, end: 4 } },
  { in: '[label](sources/a.pdf:1-4) cover', out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' } },
  // E-books: binary name tolerated, companion preferred; both are `line`
  { in: 'sources/book.epub:12-20', out: { kind: 'source', file: 'book.epub', start: 12, end: 20 } },
  { in: 'sources/book.epub.md:12-20', out: { kind: 'source', file: 'book.epub.md', start: 12, end: 20 } },
  // User files
  { in: 'files/report.pdf:3', out: { kind: 'file', node: undefined, name: 'report.pdf', start: 3, end: 3 } },
  { in: 'files/draft.md:10-12', out: { kind: 'file', node: undefined, name: 'draft.md', start: 10, end: 12 } },
  { in: 'ownership/intro/files/report.pdf:3', out: { kind: 'file', node: 'ownership/intro', name: 'report.pdf', start: 3, end: 3 } },
  { in: 'правила-заимствования/files/notes.txt:4-5 (см. таблицу)', out: { kind: 'file', node: 'правила-заимствования', name: 'notes.txt', start: 4, end: 5, comment: 'см. таблицу' } },
  { in: 'files/photo.png', out: { kind: 'file', node: undefined, name: 'photo.png' } },
  { in: 'files/report.pdf.', out: { kind: 'file', node: undefined, name: 'report.pdf' } },
  // URLs (unchanged)
  { in: 'https://doc.rust-lang.org/book/ch04-02.html', out: { kind: 'url', url: 'https://doc.rust-lang.org/book/ch04-02.html' } },
  { in: '[The Book](https://doc.rust-lang.org/book/)', out: { kind: 'url', url: 'https://doc.rust-lang.org/book/', title: 'The Book' } },
  // Negative: ref not first → text
  { in: 'see sources/a.md:1-2', out: { kind: 'text' } },
  { in: 'Chapter 4 of sources/a.md', out: { kind: 'text' } },
  // A non-numeric "range" is a comment on a ref without a range (opens the PDF on page 1)
  { in: 'sources/a.pdf:p. 3', out: { kind: 'source', file: 'a.pdf', start: undefined, comment: 'p. 3' } },
  { in: 'sources/a.pdf:pages 3-5', out: { kind: 'source', file: 'a.pdf', start: undefined, comment: 'pages 3-5' } },
  // Negative: unknown extension, path tricks, other folders, zero → text
  { in: 'sources/notes', out: { kind: 'text' } },
  { in: 'sources/../tree.md:1', out: { kind: 'text' } },
  { in: 'files/../node.md:1', out: { kind: 'text' } },
  { in: 'attachments/chart.svg', out: { kind: 'text' } },
  { in: 'sources/a.md:0-3', out: { kind: 'text' } }, // start must be ≥ 1 (web: reject or clamp; reject = text)
];

/**
 * Inline (body) refs: the existing INLINE_SOURCE_RE rewrite of bare `sources/<file>:a[-b]`
 * mentions in prose into links is unchanged in scope (it already handles Unicode names in the
 * working tree). Extending it to `files/…` is NOT required by this feature.
 */
export type InlineRefs = never;
