# Plan — `rich-answers` / project `web`

Stack: React 19 + Vite 8 + TypeScript 7, TanStack Query 5, react-markdown 10 + remark-gfm + rehype-highlight, vitest (node environment, pure unit tests only). Root: `web/`.
Role: **client**. Contract: `.claude/features/rich-answers/contracts/` (`attachments.ts`, `http.ts`, `sse.ts`). This plan follows it exactly. `agent-tool.ts` is server-internal; the web ignores it.

There is no codegen. `web/src/api/types.ts` is hand-maintained and mirrors the contract. Updating it is part of this plan (step 1).

## 1. Design summary

- **Types and API.** Mirror `AttachmentInfo`, `AttachmentKind`, `AttachmentOrigin`, `AttachmentEvent`, `PREVIEW_LIMITS`, `ATTACHMENT_LINK_PREFIX` in the web. `ChainNode.attachments` is added. `sendMessage` gets an `onAttachment` callback and resolves to `{ nodeId, attachments }` instead of a bare `nodeId`. New helper `attachmentUrl(tree, node, name, download?)`.
- **Attachment scope.** Each `Exchange` provides an `AttachmentScope` React context: `{ treeId, nodeId | null, attachments, streaming: StreamingAttachment[] | null }`. Markdown overrides (`img`, `a`) and the attachment list read it. A committed node uses `node.id` + `node.attachments`. A streaming answer has `nodeId = null` and the live list built from `attachment` SSE events. URLs are not fetchable until `done`, so streaming items show status only.
- **Markdown renderer** (`Markdown.tsx`) gets three new code-fence renderers and two link renderers:
  - ```` ```mermaid ```` → `MermaidBlock` (lazy-loaded `mermaid`, rendered only once the fence is closed, "Diagram / Source" toggle, source + error note on failure);
  - ```` ```csv ```` / ```` ```tsv ```` → `CsvBlock` (parsed with our own `lib/csv.ts` → `DataTable`, raw fallback);
  - GFM `table` → `SmartTable` (sort / filter / Export CSV over the rendered rows);
  - `![alt](attachments/x.svg|png…)` → inline `<img>` from the attachment URL (SVG only through `<img>`, so scripts never run and external refs never load);
  - `[label](attachments/x)` → an attachment chip that opens the attachment viewer.
  - A missing name → broken-attachment placeholder.
- **Attachment list.** Under every answer with attachments: `AttachmentList`. It always lists every attachment of the node (Open question 3, proposed "yes"). Each card shows a kind badge, name, size and Download. Inline previews are image/SVG thumbnails and table previews. Text and PDF open in the side viewer. Every preview respects `PREVIEW_LIMITS`.
- **Side viewer.** `App` viewer state becomes a union: source (existing) | attachment (new). `AttachmentViewer` reuses the `.viewer` layout and shows text/code (highlighted), a table (`DataTable`), an image/SVG (`<img>`) or a PDF (blob-URL `<iframe>`, see risk R1).

## 2. Dependencies

| Package | Where | Why |
|---|---|---|
| `mermaid` (latest 11.x) | `dependencies` | Diagram rendering. Always loaded with `import('mermaid')` so it stays a separate Vite chunk and never affects first load. |

No other new deps:
- CSV parse/serialize is hand-written (`lib/csv.ts`, unit-tested, per the NFR "parsing helpers get unit tests");
- SVG safety comes from `<img>` rendering plus the server CSP, so there is no DOMPurify;
- mermaid's own `securityLevel: 'strict'` sanitizes its output (it bundles DOMPurify).

Command (implement stage): `pnpm --filter @otago/web add mermaid`.

## 3. Files to change

### `web/src/api/types.ts`
Mirror the contract by hand:
```
AttachmentKind = 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other'
AttachmentOrigin = 'inline' | 'url' | 'sandbox'
AttachmentInfo { name; size; contentType; kind; origin? }
AttachmentEvent = saving{key, requestedName?, origin} | ready{key, attachment} | failed{key, requestedName?, message}
ChainNode += attachments: AttachmentInfo[]
MessageDone { nodeId: string; attachments: AttachmentInfo[] }
```
Add a header comment: "Mirrors .claude/features/rich-answers/contracts (server owns the shape)".

### `web/src/api/client.ts`
- `attachmentUrl(treeId, nodeId, name, download = false)` returns `/api/trees/${enc(tree)}/attachments?node=${enc(node)}&name=${enc(name)}` (+`&download=1`). This is exactly the contract's URL recipe.
- `api.getAttachmentText(treeId, nodeId, name)` uses `fetch` + `res.text()` (errors through `errorOf`).
- `api.getAttachmentBlob(treeId, nodeId, name)` returns `Blob` (used for the PDF preview).
- `getChain`: when an older server omits the field, default it with `attachments ?? []`. This is defensive only; the contract says the field is always present.
- `SendMessageInput.onAttachment?: (event: AttachmentEvent) => void`.
- `sendMessage` returns `Promise<MessageDone>`:
  - `event === 'attachment'` → `onAttachment?.(data)`;
  - `done` → `{ nodeId, attachments: data.attachments ?? [] }`;
  - unknown events are ignored (forward-compatible).

### `web/src/api/queries.ts`
- `keys.attachment(tree, node, name, size)`. `size` is in the key so a regenerated file with the same name is refetched. It is also covered by `Cache-Control: no-cache`, but query cache is separate.
- `useAttachmentText(tree, node, name, size, enabled)`.

### `web/src/components/chat/ChatView.tsx`
- `Pending` gains `attachments: StreamingAttachment[]`, where `StreamingAttachment = { key; status: 'saving' | 'ready' | 'failed'; requestedName?; origin?; attachment?: AttachmentInfo; message? }`.
- `onAttachment` reduces events by `key` with a pure reducer `applyAttachmentEvent(list, event)` in `lib/attachments.ts`. Order: first seen, `saving` → `ready | failed`. An unknown key on `ready`/`failed` is inserted too (robust to a missed `saving`).
- On `done`, the optimistic chain entry includes `attachments: done.attachments`, so the list and inline images become fetchable right away (the files are committed before `done`).
- Pass the attachment scope to each `Exchange`:
  - committed: `{ treeId, nodeId: node.id, attachments: node.attachments, streaming: null }`;
  - pending: `{ treeId, nodeId: null, attachments: [], streaming: pending.attachments }`.
- On `error`/abort the server writes nothing. Pending "failed" state keeps the event list, labelled "Not saved". No download links, because the files never existed.
- Add `pending?.attachments.length` to the scroll layout-effect deps so new cards keep the view pinned.

### `web/src/components/chat/Exchange.tsx`
- New prop `attachments: AttachmentScopeValue`.
- Wrap the assistant message in `<AttachmentScope.Provider>`.
- Render `<AttachmentList />` after `<Markdown>` and before the caret/footer. It renders nothing when the scope is empty.

### `web/src/components/chat/Markdown.tsx`
- New prop `streaming?: boolean` (from `Exchange`), used to decide whether an unclosed fence is still "in progress".
- `pre` override: find the language (`languageOf`, already present):
  - `mermaid` → `<MermaidBlock source closed />`
  - `csv` / `tsv` → `<CsvBlock source delimiter closed />`
  - otherwise the existing `CodeBlock`.

  `closed` = `isFenceClosed(body, node.position)` from `lib/fences.ts`. It slices the source by `node.position.start/end.offset` and checks that it ends with a closing fence of the same marker. The positions refer to `body` (the post-`extractCitations` text that ReactMarkdown actually parses). An unclosed fence on a finished answer (streaming=false) counts as closed, so a render is still attempted and an error falls back to the source.
- `table` override → `<SmartTable node={node}>{children}</SmartTable>` (replaces the plain `.table-wrap`).
- `img` override: `src` starting with `ATTACHMENT_LINK_PREFIX` → `<AttachmentImage name alt />`. Other `img` elements are unchanged.
- `a` override: add a branch before the existing ones. `href` starting with `ATTACHMENT_LINK_PREFIX` → `<AttachmentLink name>{children}</AttachmentLink>`. The name is `decodeURIComponent(href.slice(prefix.length))`, stripping a leading `./` too.
- `rehype-highlight` with `detect: false` leaves `mermaid`/`csv`/`tsv` unhighlighted (they are not registered). That is fine, because we read the raw text through `textOf(node)`. Check at implement time that it does not throw on an unknown language (v7 records a vfile message only).
- `react-markdown`'s `defaultUrlTransform` keeps relative URLs like `attachments/x.svg`, so no `urlTransform` change is needed.

### `web/src/App.tsx`
- `viewer` state becomes `ViewerTarget = { kind: 'source'; view: SourceView } | { kind: 'attachment'; view: AttachmentView }`.
- Provide `AttachmentViewerContext` (`openAttachment(view)`) next to `SourceViewerContext`.
- Render `SourceViewer` or `AttachmentViewer` in `.chat-pane`. Closing, or switching the tree, resets it (as today).

### `web/src/components/source-viewer-context.ts`
- Add `AttachmentView { treeId; nodeId; attachment: AttachmentInfo }`, `AttachmentViewerContext`, `useOpenAttachment`. It stays in the same file to keep the viewer contexts together; a separate file is also fine.

### `web/src/styles/markdown.css` and `web/src/styles/base.css`
Follow the existing light design: serif text, `var(--radius)` (3px) corners, 1px `var(--line)` borders, `var(--panel)` headers.
- New classes:
  - `.mermaid-block` (+ `.mermaid-svg`, `.mermaid-error`);
  - `.data-table` (sticky header, `th[aria-sort]` arrows, `.data-table-bar` with filter input + counts + buttons);
  - `.attachments` / `.attachment-card` / `.attachment-thumb` / `.attachment-status` (`saving` pulse, `failed` with `var(--danger)`);
  - `.attachment-broken`, `.attachment-chip`.
- Images: `max-width: 100%; height: auto`. SVG gets a white background so transparent SVGs stay readable.

## 4. Files to create

| Path | Purpose |
|---|---|
| `web/src/lib/attachments.ts` | Constants mirrored from the contract (`ATTACHMENT_LINK_PREFIX`, `ATTACHMENT_NAME_PATTERN`, `PREVIEW_LIMITS`). Also `parseAttachmentHref(href): string \| null`, `applyAttachmentEvent(list, event)`, `resolveAttachment(scope, name): Resolved`, `canPreview(info): boolean`, `formatBytes(n)`. `Resolved` is `{state:'ready', info, url}` \| `{state:'staged', info}` \| `{state:'saving'}` \| `{state:'failed', message}` \| `{state:'missing'}`. |
| `web/src/lib/attachments.test.ts` | Unit tests for the above |
| `web/src/lib/csv.ts` | `detectDelimiter(text)` (`,` `;` `\t` `\|` by consistent column count over the first lines), `parseCsv(text, delimiter?)` returning `{ header: string[]; rows: string[][]; ragged: boolean }` or `null` when unusable. It follows RFC 4180 quotes, doubled quotes, newlines inside quotes, CRLF, BOM strip, a trailing newline, ragged rows padded or truncated to the header width. `toCsv(header, rows)` quotes as needed and uses CRLF. `downloadText(filename, text, mime)` uses Blob + object URL + a temporary `<a download>`. |
| `web/src/lib/csv.test.ts` | Unit tests: quotes, escaped quotes, embedded newline, BOM, `;` and tab detection, ragged rows, empty input → `null`, round-trip `parseCsv(toCsv(x))` |
| `web/src/lib/table.ts` | `compareCells(a, b)`: numeric-aware (plain numbers, `1,234.5`, `12%`, `-3`) then `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`; empty cells sort last. `sortRows(rows, column, direction)` is a stable sort that returns index order. `filterRows(rows, query)` is a case-insensitive substring match over any cell, with whitespace-separated terms combined by AND. |
| `web/src/lib/table.test.ts` | Unit tests for sort and filter |
| `web/src/lib/fences.ts` | `isFenceClosed(markdown, position)` |
| `web/src/lib/fences.test.ts` | Closed, unclosed (streaming tail), `~~~` fences, fence with longer closing marker |
| `web/src/api/client.test.ts` | `sendMessage` against a mocked `globalThis.fetch` that returns a `Response` with a `ReadableStream` SSE body (Node 22 has these built in). Checks chunk/attachment/done dispatch, `done.attachments`, the `error` event → `ApiError`, and that unknown events are ignored. Also checks the `attachmentUrl` encoding. |
| `web/src/components/chat/attachment-scope.ts` | `AttachmentScopeValue` type, `AttachmentScope` context, `useAttachmentScope()` |
| `web/src/components/chat/DataTable.tsx` | Controlled table over `{ header: string[]; rows: string[][] }`. Header click cycles asc → desc → none (`aria-sort`). A filter input (debounced about 150 ms via `useDeferredValue`) and "N of M rows". "Export CSV" exports the currently filtered + sorted rows through `toCsv`, as `<baseName>.csv`. Optional `truncatedFrom` shows "first N of M rows · Download full file". Also an optional `extraActions` slot (Download). It renders at most `PREVIEW_LIMITS.tableRows` rows. |
| `web/src/components/chat/SmartTable.tsx` | Wrapper for GFM tables that keeps react-markdown's rendered cells (links, code, citation chips intact): <ul><li>from the hast `node`, read header texts (`thead th`) and row texts (`tbody tr` → `td` via `textOf`);</li><li>from React `children`, find the `tbody` element and `Children.toArray(tbody.props.children)` → `tr` elements, index-aligned with the hast rows;</li><li>sort/filter reorders or hides those `tr` elements; Export CSV uses the texts.</li></ul>If the alignment check fails (row counts differ) or there is no `thead`, it falls back to the plain `.table-wrap` table without controls. Controls are shown only when the table has at least 2 body rows. |
| `web/src/components/chat/CsvBlock.tsx` | `closed` false → the existing code-block look with a muted "table renders when complete". Otherwise `parseCsv` → `DataTable` + a "Table / Source" toggle + Copy. Parse `null` → plain code block with a note "Could not parse as CSV". |
| `web/src/components/chat/MermaidBlock.tsx` | Rendering and states are described in section 5. |
| `web/src/lib/mermaid.ts` | Lazy singleton: `loadMermaid()` runs `import('mermaid')` once and then `initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: <serif var>, themeVariables: light palette matching base.css })`. `renderMermaid(source)` returns `Promise<string>` (SVG). It is serialized through a promise queue, because mermaid's render uses global state, and memoized in a `Map<source, Promise>` (bounded LRU, e.g. 50 entries). Runs `mermaid.parse(source)` first. On error it removes the stray temp element mermaid may leave in `document.body` (`#d<id>`). |
| `web/src/components/chat/AttachmentList.tsx` | Section 5 |
| `web/src/components/chat/AttachmentCard.tsx` | Section 5 |
| `web/src/components/chat/AttachmentInline.tsx` | `AttachmentImage` and `AttachmentLink` (markdown references) + `BrokenAttachment` placeholder |
| `web/src/components/AttachmentViewer.tsx` | Side-panel viewer (section 5) |

## 5. Component behavior

### MermaidBlock
- `closed === false` → show the source in a code block with a muted "diagram renders when complete". No render attempt.
- Otherwise `useEffect` → `renderMermaid(source)`, cancelled on unmount or source change with a stale flag.
- States:
  - loading: a muted placeholder of the same height;
  - ok: diagram view (the SVG string injected into `.mermaid-svg` via `dangerouslySetInnerHTML`; safe because `securityLevel: 'strict'` sanitizes and disables click handlers and scripts);
  - error: source code + `.mermaid-error` note with the first line of the parser message.
- Header: "mermaid" label, a "Diagram / Source" toggle, Copy (source).
- Wide diagrams scroll horizontally (`overflow-x: auto`). No zoom (non-goal).

### AttachmentList (under each answer)
- Committed scope: `attachments.map(info => <AttachmentCard info url=attachmentUrl(...)/>)`. It shows every attachment, sorted as the server returns them.
- Streaming scope: `streaming.map(item => …)`:
  - `saving` → card with the requested name (or "downloading…" for `origin: 'url'` with no name) + a "saving…" status;
  - `ready` → final name, size, kind badge, "ready · available when the answer is saved" (the contract says staged files are not fetchable);
  - `failed` → requested name + a `var(--danger)` message.
- Section heading "Attachments (N)", in the same visual style as the `.citations` block.

### AttachmentCard (committed)
- Row: kind badge (`file-badge` style, extension text) · name · `formatBytes(size)` · actions: `Preview` (opens the viewer, when `canPreview`) · `Download` (`<a href=attachmentUrl(..., true) download>`).
- Inline preview under the row:
  - `image` / `svg` with `size <= imageBytes`: `<img loading="lazy" src=url alt=name>` thumbnail (max-height ~ 320px). Click → viewer.
  - `table` with `size <= tableBytes`: `useAttachmentText` → `parseCsv` (the delimiter comes from the extension, `.tsv` → tab, else detect) → `DataTable` collapsed to about 10 visible rows with "Show all" (up to `tableRows`; beyond that `truncatedFrom`). Parse failure → "Could not parse; Preview as text".
  - `text` / `pdf` / `other`: no inline preview (the row actions only).
- Above a threshold: no fetch, text "Too large to preview" + Download.
- `<img onError>` → switch to `BrokenAttachment` (handles 404 after a node move, or a 400 name).

### AttachmentImage / AttachmentLink (in-text references)
`resolveAttachment(scope, name)`:
- `ready` (committed and found):
  - image/svg and under the limit → `<img class="md-attachment-img" src=url alt>` with a caption link "Download";
  - non-image target in `![]()` → treated like a link.
  - Link → `.attachment-chip` (badge + label). Click opens `AttachmentViewer` (preview-capable kinds) or triggers the download (`other`).
- `staged` / `saving` (streaming): a placeholder chip "name · saving…" / "name · ready".
- `failed` → broken placeholder with the message.
- `missing` (committed, not in the list) → `BrokenAttachment` ("Attachment not found: name"). Never throws.

### AttachmentViewer (side panel, reuses `.viewer*` CSS)
Header: badge, name, size, `Open ↗` (inline URL, new tab; the server CSP sandboxes it), `Download`, close (Esc too).

Body by kind:
- `text` ≤ textBytes → `useAttachmentText`. `.md` → rendered with `<Markdown plain>` with a Lines/Rendered toggle as in `SourceViewer`; others → a highlighted code block (highlight.js `highlightAuto` is not used; map the extension → language when highlight.js knows it, else plain text) with line numbers reusing `.lines`.
- `table` → full `DataTable` (up to `tableRows`).
- `image` / `svg` → `<img>` fit to the panel.
- `pdf` ≤ pdfBytes → `api.getAttachmentBlob` → `URL.createObjectURL(blob)` → `<iframe class="viewer-pdf">`. Revoked on unmount. See R1.
- Over the limit / `other` → metadata + Download.

## 6. Step ordering

1. `pnpm --filter @otago/web add mermaid`.
2. Update `api/types.ts`. Add `lib/attachments.ts` constants/helpers + tests.
3. Update `api/client.ts` (`attachmentUrl`, `sendMessage` → `MessageDone` + `onAttachment`, text/blob getters) + `client.test.ts`. Update `queries.ts`.
4. `lib/csv.ts`, `lib/table.ts`, `lib/fences.ts` + tests (pure; can be parallel with 3).
5. `DataTable`, then `SmartTable` and `CsvBlock`. Wire them into `Markdown.tsx` (`table`, `pre`).
6. `lib/mermaid.ts` + `MermaidBlock`. Wire into the `pre` override.
7. `attachment-scope.ts`, `AttachmentInline`, `AttachmentCard`, `AttachmentList`. Wire `img`/`a` overrides; `Exchange` provider + list.
8. `ChatView`: pending attachment state, reducer, `done` payload into the optimistic chain entry, scope props.
9. `AttachmentViewer` + `App` viewer union + context.
10. CSS.
11. Verify (section 7). Formatting via `pnpm format` / `pnpm check` at the repo root (do not hand-format).

Steps 4–6 depend only on step 2. Step 8 depends on 3 and 7. The web can be developed before the server lands by using the mocked-fetch unit tests. For manual testing, the server's `attachment` events and route must exist.

## 7. Test plan

Automated (`pnpm --filter @otago/web test`, node environment, no new test deps):
- `lib/csv.test.ts`, `lib/table.test.ts`, `lib/fences.test.ts`, `lib/attachments.test.ts`:
  - `parseAttachmentHref` handles `attachments/a.svg`, `./attachments/a%20b.csv` → decoded, and non-attachment hrefs → null;
  - `applyAttachmentEvent` covers ordering and an unknown key;
  - `resolveAttachment` covers all five states;
  - `canPreview` covers the limits;
  - `formatBytes`.
- `api/client.test.ts`: the SSE dispatch described above.
- Existing tests stay green (`citations`, `sse`, `tree`, `url-state`).
- `pnpm --filter @otago/web lint` (biome + `tsc --noEmit`) and `pnpm --filter @otago/web build`. Also check that `mermaid` lands in a separate chunk in the build output.

Component tests are not added: the project has no jsdom/testing-library setup. Adding one is out of scope; it could be proposed separately.

Manual verification (server with the fake or real agent):
1. An old node without attachments renders exactly as before (no "Attachments" block, same tables apart from the added controls when ≥ 2 rows).
2. A ```` ```mermaid ```` answer shows the source while streaming, then the diagram after the fence closes. The toggle shows the source. Invalid syntax shows the source + an error note, and no stray elements in `<body>`.
3. An SVG attachment referenced with `![](attachments/x.svg)`:
   - "saving…" → "ready" during streaming, then the inline image after `done`;
   - an SVG containing `<script>` and an external `<image href="http://…">` does nothing (check the DevTools network/console);
   - Download works.
4. `benchmarks.csv` attachment and a ```` ```csv ```` block: the table renders, header click sorts (numbers numerically), the filter narrows rows, Export CSV downloads the filtered/sorted rows, Download gives the original file.
5. A GFM table with links/code in cells: sort keeps the cell rendering, citation chips still work, Export CSV has plain text.
6. Base64 PNG and PDF: the PNG thumbnail works; the PDF opens in the viewer (Chrome + Firefox + Safari, see R1). An unknown type shows Download only.
7. The reference `![](attachments/typo.png)` → broken placeholder, no crash. A failed tool call → failed card during streaming, and it is absent after `done`.
8. Stop mid-stream / server error: pending shows "Not saved" and no download links. After a reload nothing is listed.
9. A 20k-row CSV attachment: first 5000 rows + "download full file"; sorting/filtering stays responsive. A file over `tableBytes` is not fetched.
10. Move a node in the graph, then reopen it: attachments load from the new id.

## 8. Risks and open points

- **R1: PDF preview vs the server CSP.** The attachment route sends `Content-Security-Policy: … sandbox`. Chromium refuses to render the built-in PDF viewer in a sandboxed document, so `<iframe src=attachmentUrl>` would show "blocked". Mitigation in this plan: fetch the bytes and preview through a `blob:` URL (blob documents do not inherit the response CSP). Alternative (server-side): omit `sandbox` for `application/pdf`. Flagged as a contract gap below. The `Open ↗` link for PDFs may hit the same issue in Chromium; Download always works.
- **R2: mermaid bundle size (~1–2 MB with its lazy sub-chunks).** Mitigated with a dynamic import; first render of a diagram has a short delay.
- **R3: mermaid global state / concurrent renders.** Mitigated with a serialized render queue + memo cache. The theme is initialized once; dark mode does not exist in the app, so no re-init is needed.
- **R4: SmartTable relies on react-markdown's element structure** (`tbody` → `tr` children aligned with hast rows). Guarded by an alignment check with a plain-table fallback. A react-markdown major upgrade needs a re-check.
- **R5: streaming re-renders.** `Markdown` re-parses on every chunk (existing behavior). MermaidBlock/CsvBlock only do work when `closed` flips or the source changes. The mermaid memo cache avoids re-rendering identical diagrams when the rest of the answer grows.
- **R6: references before the tool finishes.** The agent may write `attachments/x.png` before the `ready` event, or with a name that got a `-2` suffix. While streaming, unknown names show a neutral "pending" chip instead of "missing". The broken state is decided only for committed nodes.

## 9. Future considerations (seams, not implemented)

- `origin: 'sandbox'` is rendered generically (the origin is not shown except "downloading…" for `url`), so sandbox-emitted files appear through the same `attachment` events and list with no UI change.
- `AttachmentKind` switch statements have a default branch ("other" → Download) so new kinds degrade gracefully.
