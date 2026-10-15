# Web plan — clickable-citations

Project: `web` (`@otago/web`, React 19 + Vite, `web/src`). Role: client.
Contract: `.claude/features/clickable-citations/contracts/` (`citations.ts` is the normative
grammar; `file-routes.ts` the URL recipes and client obligations; `shared.ts` the alphabets).
Server plan: `projects/server/plan.md` (prompt wording, PDF CSP exemption, NFC on `:file`).

## Scope

1. Parser (`web/src/lib/citations.ts`): implement the contract grammar — footnote forms
   F1–F10, `sources/` refs with Unicode names delimited by a known extension, `files/` and
   `<node id>/files/` refs, ranges, the "ref first" rule, comment extraction, units
   (pages/lines/none), `CitationTarget` with the `file` kind, `comment`, and the reserved
   `quote`/`fragment` seams. Keep the uncommitted working-tree changes (Unicode
   `INLINE_SOURCE_RE`, the Cyrillic test cases); build on them.
2. "Open target" logic in ONE place (`web/src/lib/open-citation.ts`, pure, tested) that maps a
   target + `{ treeId, nodeId }` to an `OpenAction` (`new-tab` / `viewer` / `none`), and one
   small component (`TargetLink` in `Markdown.tsx`) that performs it: new tabs are real anchors
   with a precomputed `href` (never after an `await`), text targets open the in-app viewers.
3. Rendering (`Markdown.tsx`): chips, source-list rows (badge, file, `pages a–b` / `lines a–b`,
   muted comment, `IdPath` for node ids), inert rows for `files/` refs while streaming, chip
   tooltip with the comment.
4. Viewers: `SourceViewer` keeps its line view (extracted into a shared `LineView`), header
   label says pages/lines by unit; `AttachmentViewer` learns an optional line range (scroll +
   highlight) for user files opened from a citation.
5. i18n (`common`: `page`/`pages`; `chat.citations`: a hint for not-yet-openable rows), CSS
   for the comment, docs line in `CLAUDE.md`.

No API change on the web side: `sourceUrl` / `userFileUrl` in `web/src/api/client.ts` are
reused unchanged (the demo shim re-exports exactly these names — adding an export to
`client.ts` would break the demo's `exportsComplete` guard, so URL building for citations lives
in `lib/open-citation.ts`, not in `client.ts`).

## Files

| File | Change |
|---|---|
| `web/src/lib/citations.ts` | Rewrite the parser to the contract grammar (details below). Keep `extractCitations`, `INLINE_SOURCE_RE`, `hostOf`, `pathOf`, `CITE_HREF_PREFIX` as they are in the working tree. |
| `web/src/lib/citations.test.ts` | Keep existing cases (adjust `parseSourceRef('sources/a%20b.md:1-2')`: decoding now happens in the link forms / the Anchor, so decode before calling or move the case to a `[x](sources/a%20b.md:1-2)` footnote). Add the full contract CONFORMANCE table (every row), comment extraction cases, unit/label cases. |
| `web/src/lib/open-citation.ts` | NEW. Pure: `openActionFor(target, scope)` → `OpenAction`; `citationHref(action)`; uses `sourceUrl`/`userFileUrl` from `../api/client` (same pattern as `lib/attachments.ts` importing `attachmentUrl`). |
| `web/src/lib/open-citation.test.ts` | NEW. Action table (below). |
| `web/src/lib/sources.ts` | No change expected (`viewableFile`, `ebookExtensionOf`, `formatLabel` are reused by `citations.ts`). If `unitOf` is placed here instead of `citations.ts`, add a test in `sources.test.ts`. |
| `web/src/components/chat/Markdown.tsx` | `CitationChip`, `CitationList` rows, `Anchor` route every source/file ref through one `TargetLink`; drop `openTarget` and `SourceLink`; add `useCitationScope` (reads `AttachmentScope` → `{ treeId, nodeId }`). |
| `web/src/components/chat/Markdown.test.tsx` | Component tests (below). |
| `web/src/components/source-viewer-context.ts` | `AttachmentView` gains optional `start?: number; end?: number` (1-based lines to scroll to / highlight; `text` kind only). `SourceView` unchanged. |
| `web/src/components/LineView.tsx` | NEW. The numbered-lines block extracted from `SourceViewer` (`.lines` / `.line-hit` / scrollIntoView of `start`), props `{ text, start?, end? }`. |
| `web/src/components/SourceViewer.tsx` | Use `LineView`; header range label via `describeRange(file, start, end)` (pages for `.pdf`, lines otherwise). PDF iframe path unchanged (still used by the sidebar's Sources panel). |
| `web/src/components/AttachmentViewer.tsx` | `TextBody`: when `view.start !== undefined` render `LineView` (scroll + highlight) instead of `CodeText`; header shows the range label; hide the size when it is unknown (`0`). |
| `web/src/i18n/locales/en/common.ts`, `ru/common.ts` | Add `page: 'page {{start}}'`, `pages: 'pages {{start}}–{{end}}'` / `страница {{start}}`, `страницы {{start}}–{{end}}`. |
| `web/src/i18n/locales/en/chat.ts`, `ru/chat.ts` | `citations.afterSave: 'Opens when the answer is saved'` / `'Откроется после сохранения ответа'` (tooltip of an inert `files/` row and chip while streaming). |
| `web/src/styles/markdown.css` | `.cite-comment` (muted, `min-width: 0`, ellipsis via the existing `.truncate`), `.cite-row` as `<a>` for new-tab rows reuses `.external-mark`; `.cite-chip` as `<a>` needs the same box styles as the button variant (`text-decoration: none`). |
| `CLAUDE.md` (Web section, one line) | Citations: parser in `lib/citations.ts`, open logic in `lib/open-citation.ts`; PDFs open in a new tab at `#page=N`, text in the viewer. |

No generated files, no data-model changes on disk, no new API calls.

## Parser design (`web/src/lib/citations.ts`)

Types (field names binding per contract §5):

```ts
export type CitationUnit = 'page' | 'line' | 'none';
export interface CitedRange { start?: number; end?: number }
interface FutureSeams { quote?: never; fragment?: never }   // reserved, never produced
export type CitationTarget =
  | ({ kind: 'source'; file: string; comment?: string } & CitedRange & FutureSeams)
  | ({ kind: 'file'; node?: string; name: string; comment?: string } & CitedRange & FutureSeams)
  | { kind: 'url'; url: string; title?: string; comment?: string }
  | { kind: 'text'; text: string };
export type FileTarget = Extract<CitationTarget, { kind: 'source' | 'file' }>;
```

Regexes: copy `REF_BOUNDARY`, `RANGE_BOUNDARY`, `RANGE`, `KNOWN_EXT`, `SOURCE_CHARS`,
`USER_FILE_NAME`, `NODE_SEGMENT_SOURCE`, `SOURCE_REF_RE` (flags `iu`), `FILE_REF_RE` (flag
`u`) from the contract verbatim (comment: "mirrors contracts/citations.ts"). The web never
imports the planning contract at runtime.

Functions:

- `unitOf(name): CitationUnit` — `.pdf` → `page`; `.md`/`.txt` or an e-book extension
  (`ebookExtensionOf` from `./sources`) → `line`; else `none`. Case-insensitive.
- `viewableName(name)` — `viewableFile` from `./sources` (e-book → `<name>.md`); same for
  `files/` names.
- `parseRef(text): { target: FileTarget; rest: string } | null` — matches `SOURCE_REF_RE` then
  `FILE_REF_RE` at the start of `text`; `rest` = text after the match. Range: `start`
  undefined when absent; `:a` → `end = start`; `end < start` → `end = start`; `start < 1` →
  null (row `sources/a.md:0-3` → `text`). File names and node ids `.normalize('NFC')`.
  `start`/`end` keys are always present (explicit `undefined`) so `toEqual` snapshots stay
  stable (today's behaviour).
- `parseSourceRef(ref)` — kept for `Anchor` and the existing tests: `parseRef` restricted to
  `source` with an empty `rest`; no percent-decoding any more (callers decode: `Anchor` already
  does `safeDecode`). Add `parseFileRef(ref)` the same way, or a combined
  `parseWholeRef(ref): FileTarget | null` used by `Anchor` (decode first).
- `extractComment(rest): string | undefined` — trim; strip ONE leading separator of
  `— – - : , ;`; trim; if wrapped in exactly one `(` … `)` pair, strip and trim; empty →
  undefined.
- `parseCitationTarget(raw)`:
  1. `text = raw.trim()`; strip one trailing `.`, `,` or `;`.
  2. F3/F4: `` /^`([^`]+)`(.*)$/s `` → `parseRef(inner)`; the inner `rest` must be blank,
     comment from the outer remainder.
  3. F6/F7: `/^\[([^\]]*)\]\((\S+?)\)(.*)$/s` → destination `safeDecode`d; `parseRef` with
     blank inner rest → file target + comment from the remainder; else if the destination is
     a URL → `{ kind: 'url', url, title: label || undefined, comment }`.
  4. F5: `/^<([^>]+)>$/` → unwrap, then F1 on the inner text (no comment possible).
  5. F1/F2: `parseRef(text)` → target + `extractComment(rest)`.
  6. F8/F9: existing `URL_RE` behaviour (unchanged; `title` = the non-URL text).
  7. F10: `{ kind: 'text', text }`.
  `comment` is only set when non-empty (the key is absent otherwise, so existing `toEqual`
  cases without `comment` keep passing).
- `describeRange(name, start?, end?): string | undefined` — i18n: unit `page` →
  `common:page`/`common:pages`; `line` → `common:line`/`common:lines`; `none` or no start →
  undefined. Used by rows, chips, both viewers.
- `describeTarget(target)` — `source`: `file[ · range]`; `file`: `[node/]files/name[ · range]`;
  both append ` — comment` when present (chip tooltip, feature.md default "yes"); `url`:
  `title ?? url`; `text`: text.
- `labelOf(target)` (display file name): `source` → `file`; `file` → `name`. Badge:
  `formatLabel(name)` from `./sources` (`book.epub.md` → `epub`).

`INLINE_SOURCE_RE` and `extractCitations` are untouched (contract §7 note: bare `files/…`
mentions in prose are not rewritten).

## Open logic (`web/src/lib/open-citation.ts`)

```ts
export interface CitationScope { treeId: string; nodeId: string | null }  // null = streaming
export type OpenAction =
  | { kind: 'new-tab'; url: string }
  | { kind: 'viewer'; where: 'source'; name: string; start?: number; end?: number }
  | { kind: 'viewer'; where: 'file'; node: string; name: string; start?: number; end?: number }
  | { kind: 'none' };
export const PDF_PAGE_FRAGMENT = (page: number) => `#page=${page}`;
export function openActionFor(target: CitationTarget, scope: CitationScope): OpenAction
```

Rules (contract §6):
- `url` → `new-tab` with `target.url`.
- `source`/`file`, unit `page` → `new-tab`: `sourceUrl(treeId, file)` /
  `userFileUrl(treeId, node, name)` + (`start` ? `#page=<start>` : '').
- unit `line` → `viewer` on `viewableName(name)` with `start`/`end`; `where: 'file'` carries
  the resolved node.
- unit `none` → `new-tab` with the plain file URL (inline; images render natively).
- `file` with `node` undefined and `scope.nodeId === null` → `none`.
- `text` → `none`.
- Ids/names are already NFC from the parser; `openActionFor` normalizes once more
  (`normalize('NFC')`) so a target built elsewhere (e.g. `Anchor`) is safe too.
- Seams: `quote`/`fragment` are read nowhere yet; a future text-fragment URL or in-viewer
  quote highlight plugs in here (`new-tab` url suffix / `viewer` extra field) without touching
  the renderer.

## Rendering (`web/src/components/chat/Markdown.tsx`)

- `useCitationScope()`: `const scope = useAttachmentScope(); return scope ? { treeId: scope.treeId, nodeId: scope.nodeId } : null`.
  The exchange already provides `AttachmentScope` with `nodeId: node.id` for saved nodes and
  `nodeId: null` for in-flight ones (`Exchange.tsx` / `InFlightExchange.tsx`), so no new prop
  plumbing is needed; `null` scope (plain viewers) behaves like streaming. The scope is read
  by the citation components through context, so a saved node re-renders them even though
  `Markdown` is `memo`'d on `text`.
- `TargetLink({ target, className, title, children })`: computes `openActionFor(target, scope)`;
  renders `<a href={url} target="_blank" rel="noopener noreferrer">` for `new-tab` (the href is
  precomputed, so the browser opens it synchronously from the click — pop-up safe),
  `<button type="button" onClick>` for `viewer` (`openSource({ file, start, end })` or
  `openAttachment({ treeId, nodeId: node, folder: 'files', attachment, start, end })`), and a
  disabled `<button>` (chip) / `<span>` (row) for `none`. This is the single place that
  performs an action.
  - Viewer `attachment` for a cited user file: `{ name: viewable, kind: 'text', contentType:
    name ends with `.md` ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8', size: 0 }`
    (size unknown — 0 passes `PREVIEW_LIMITS`; the query key differs from the card's, so the
    text is fetched once more at most; same trick as `AttachmentCard.openCompanion`).
- `CitationChip`: `TargetLink` with `className="cite-chip cite-<kind>"`, `title =
  describeTarget(target)` (includes the comment); inert (`disabled`) when the action is
  `none`, with `title = t('chat:citations.afterSave')` for a `files/` ref while streaming.
- `CitationList` rows:
  - `source`: badge `formatLabel(file)`, `<span class="cite-file" dir="auto">{file}</span>`,
    `<span class="cite-lines">{describeRange(...)}</span>`, `<span class="cite-comment muted truncate" dir="auto" title={comment}>{comment}</span>`,
    `↗` `external-mark` when the action is `new-tab`.
  - `file`: same, but the name is `files/<name>` preceded by `<IdPath id={node} />` + `/` when
    `node` is set; while streaming the row is a `<span class="cite-row cite-text">` with the
    same content and the `afterSave` tooltip.
  - `url`: unchanged (plus the muted comment when present).
  - `text`: unchanged.
  Comments are plain text, `dir="auto"`, CSS-truncated with the full text in `title`; no
  Markdown. If JS truncation is ever needed, use `truncateGraphemes` (`lib/text.ts`), never
  `slice`.
- `Anchor`: any href that decodes to a whole file ref (`parseWholeRef(safeDecode(href))`)
  renders `TargetLink` (so an inline `sources/a.pdf:3` link opens the PDF tab, an inline
  `.md` ref opens the viewer as today). Attachment hrefs and external URLs unchanged.
- `RenderContext` unchanged (`body`, `streaming`, `citations`).

## Viewers

- `LineView` (new, `web/src/components/LineView.tsx`): the current `.lines` block of
  `SourceViewer` with the `highlight` ref on `start` and `scrollIntoView({ block: 'center' })`
  when text arrives or the range changes; `line-hit` on `start..end`. Out-of-range lines →
  nothing highlighted (contract edge case).
- `SourceViewer`: `LineView` in place of the inline map; header range via
  `describeRange(file, start, end)`. Everything else (rendered toggle, book/raw links, PDF
  iframe for the sidebar) unchanged. `.pdf` citations never reach it any more (new tab).
- `AttachmentViewer`: `AttachmentView.start/end`; `TextBody` renders `LineView` when
  `view.start !== undefined` (and the rendered toggle is off); header appends
  `describeRange(attachment.name, start, end)` and hides `formatBytes` when `size === 0`.
  The existing "a new view resets state" effect already keys on `view`.
- `App.tsx`: no change (viewer state already carries any `AttachmentView`).

## Interface changes

- `lib/citations.ts`: `CitationTarget` gains `file` kind, `comment`, reserved seams;
  `parseSourceRef` no longer percent-decodes (callers decode); new `parseRef`,
  `parseWholeRef`, `unitOf`, `viewableName`, `describeRange`, `extractComment`.
- `source-viewer-context.ts`: `AttachmentView.start?/end?`.
- New `lib/open-citation.ts` (`openActionFor`, `OpenAction`, `CitationScope`,
  `PDF_PAGE_FRAGMENT`).
- i18n keys: `common.page`, `common.pages`, `chat.citations.afterSave` (both locales; the
  `ru` files are `satisfies Messages<typeof en>` so a missing key fails `tsc`).
- The demo bundles `web/src` as is; it needs no copy of the parser. Its mock `sourceUrl` /
  `userFileUrl` keep their signatures (demo plan).

## Step order

1. `lib/citations.ts` + `citations.test.ts`: types, regexes, `parseRef`, comment extraction,
   `parseCitationTarget` forms, `unitOf`/`viewableName`/`describeRange`/`describeTarget`;
   paste the CONFORMANCE table; `pnpm --filter @otago/web test -- src/lib/citations.test.ts`.
2. i18n keys (both locales) — needed by `describeRange`.
3. `lib/open-citation.ts` + test.
4. `source-viewer-context.ts` (`start`/`end`), `LineView.tsx`, `SourceViewer.tsx`,
   `AttachmentViewer.tsx`.
5. `Markdown.tsx`: `useCitationScope`, `TargetLink`, chip, rows, `Anchor`; CSS.
6. `Markdown.test.tsx` component tests.
7. `CLAUDE.md` line. `pnpm check` (Biome, never hand-format), `pnpm --filter @otago/web lint`,
   `pnpm --filter @otago/web test`, `pnpm --filter @otago/demo lint` (the demo compiles
   `web/src`; the `exportsComplete` guard must still hold).
8. Manual check with the dev server (after the server's PDF CSP change is in): a PDF source
   citation with a comment opens a new tab on the page (Chromium/Firefox; Safari page 1), a
   `.md` citation scrolls the viewer, a `files/report.pdf:3` citation in a saved answer opens
   the user file tab, a `files/draft.md:10-12` one opens the viewer with the range, the same
   row is inert while the answer streams.

## Test plan

`web/src/lib/citations.test.ts`
- `describe('conformance (contract table)')`: `it.each` over a verbatim copy of the 35
  CONFORMANCE rows (`in` → `parseCitationTarget(in)` `toMatchObject(out)`; strip `undefined`
  entries from `out` before matching and assert them with `toBeUndefined()` so the
  `start: undefined` / `node: undefined` rows are meaningful).
- Comment extraction: `(cover)`, `— cover`, `, cover.`, `: see p. 3`, `((nested))` keeps the
  inner parens, blank → undefined; a comment never yields a second ref.
- Wrappers: backtick ref with inner leftover (`` `sources/a.pdf:1-4 x` ``) → `text`;
  `<sources/a.md:2-3>`; `[label](files/a.md:1)` (link form, label ignored);
  `[Book](https://x) note` → url + title + comment.
- Ranges: `end < start` → `end = start`; `:0` → text; `:3 – 5` spaces; `.PDF` upper case.
- Units/labels: `unitOf('a.PDF') = 'page'`, `'book.epub' = 'line'`, `'book.epub.md' = 'line'`,
  `'photo.png' = 'none'`; `describeRange('a.pdf', 5, 12) = 'pages 5–12'`,
  `('a.pdf', 3, 3) = 'page 3'`, `('a.md', 1, 4) = 'lines 1–4'`, `('photo.png', 1) = undefined`;
  `describeTarget` with a comment → `'a.pdf · pages 1–4 — cover'`; file kind →
  `'ownership/intro/files/report.pdf · page 3'`.
- NFC: an NFD `sources/café.md:1` yields the NFC `file`.
- Existing `extractCitations` / `INLINE_SOURCE_RE` / `pathOf` tests unchanged.

`web/src/lib/open-citation.test.ts`
- source pdf with range → `new-tab` `/api/trees/t/sources/a.pdf#page=5`; without range → no
  fragment; Unicode name percent-encoded once.
- source md → `viewer source` with `start`/`end`; `book.epub` → `name: 'book.epub.md'`.
- file pdf, own node (`nodeId: 'n'`) → `new-tab` `/api/trees/t/files?node=n&name=report.pdf#page=3`;
  file with explicit node → that node; file own node while streaming (`nodeId: null`) → `none`;
  file md → `viewer file`; `photo.png` → `new-tab` without fragment; `url` → `new-tab`;
  `text` → `none`.

`web/src/components/chat/Markdown.test.tsx` (server render, like the existing cases;
`render(text, scope)` with the committed scope `treeId: 't', nodeId: 'n'`)
- PDF source row + chip: `[^1]: sources/book.pdf:5-12 (contents)` → row is an `<a>` with
  `href="/api/trees/t/sources/book.pdf#page=5"`, `target="_blank"`, contains `pages 5–12`,
  the comment in `cite-comment`, badge `pdf`; the chip is an `<a>` with the same href and a
  `title` containing `contents`.
- Text source row: `[^1]: sources/notes.md:120-134` → a `<button>` row with `lines 120–134`
  (no href).
- User file own node: `[^1]: files/report.pdf:3` → href
  `/api/trees/t/files?node=n&amp;name=report.pdf#page=3`; `[^2]: files/draft.md:10-12` →
  button row with `lines 10–12`.
- Other node with `IdPath`: `[^1]: ownership/intro/files/report.pdf:3` → href with
  `node=ownership%2Fintro`, row contains `<bdi>ownership</bdi>` and `<bdi>intro</bdi>`.
- Streaming (scope `nodeId: null`, `streaming = true`): `files/report.pdf:3` → no href, the
  row is a `cite-text` span with `Opens when the answer is saved`, the chip is `disabled`;
  a `sources/` row in the same answer is still clickable.
- Comment + text: `[^1]: see sources/a.md:1-2` → `cite-text` row (ref not first).
- Inline link: `[x](sources/a.pdf:3)` in the body → external anchor with `#page=3`;
  `[x](sources/a.md:3)` → button.
- Existing attachment/table/mermaid/plain tests unchanged (`plain` renders no source list).

Viewers (optional, SSR smoke in a new `LineView.test.tsx`): lines `1..3` with `start=2,end=3`
→ two `line-hit` rows; `start` beyond the text → none.

## Out of scope / seams

- Text fragments for URLs, in-app PDF viewer, in-text quote highlight, `.pdf.md` extraction:
  the `quote`/`fragment` fields exist on `CitationTarget` and `openActionFor` is the one place
  that would read them.
- Rewriting bare `files/…` mentions in prose (`INLINE_SOURCE_RE`) — not required.
- The sidebar Sources panel keeps opening PDFs in the iframe viewer.
