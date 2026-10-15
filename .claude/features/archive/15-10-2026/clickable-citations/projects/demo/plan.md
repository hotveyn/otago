# Demo plan — clickable-citations

Project: `demo` (`@otago/demo`, `demo/src/mock`, `demo/seed`). Client of the contract in
`.claude/features/clickable-citations/contracts/` (`index.ts`, `shared.ts`, `citations.ts`,
`file-routes.ts`, `prompt.ts`). The web UI changes are planned in `projects/web/plan.md`
(written concurrently); the demo bundles that web code unchanged, so this plan covers only
what the mock backend and the seed must do for the same web code to behave per the contract.

Built on the working tree, which already holds the uncommitted Unicode-source-name change
(`demo/src/mock/files.ts` imports `server/src/storage/source-names.ts`; `demo.ts` NFC on
upload; `demo.test.ts` "accepts Unicode names"). Keep it.

## Findings (what already works, what does not)

1. **Blob MIME types are right.** `demo.urls.source` → `BlobUrls.url(path,
   trees.sourceContentType(file))`; `demo.urls.nodeFile` → `BlobUrls.url(path,
   trees.fileContentType(name))`. Both create `new Blob([bytes], { type })` with
   `application/pdf` for `.pdf`, `text/markdown; charset=utf-8` / `text/plain; charset=utf-8`
   for text, image types for images. `URL.createObjectURL` output carries no fragment, so the
   web's `sourceUrl(...) + '#page=N'` / `userFileUrl(...) + '#page=N'` yields
   `blob:<origin>/<uuid>#page=N`. Chromium/Edge (PDFium viewer) and Firefox (pdf.js) read the
   open-params from the navigated URL's hash, blob or not; Safari ignores it (contract:
   accepted). Nothing to change in `blob-urls.ts`.
2. **No CSP applies.** Blob responses have no headers, so the server's decision 2 (drop the
   sandboxing CSP for PDFs) has no demo counterpart. One thing had to be verified because a
   `blob:` document inherits the CSP of the document that created it: the demo page itself
   sends no CSP (`demo/vercel.json` has only the SPA rewrite, `demo/index.html` has no CSP
   meta). Confirmed: nothing to change, and nothing must be added later (a page CSP with
   `sandbox` would break the PDF tab; note this in CLAUDE.md).
3. **NFC gap (parity with the server's one hardening).** `urls.source(treeId, file)`,
   `api.getSourceText(id, file)` and `api.deleteSource(id, file)` use `file` as given;
   `trees.sourcePath` does not normalize. The server plan normalizes `:file` to NFC on
   `GET/DELETE /sources/:file`. Mirror it in `demo.ts` (`nfc(file)` in those three places).
   `urls.nodeFile` already normalizes the node id; user-file names are ASCII.
4. **Missing file → "404".** `BlobUrls.url` returns a `text/plain` blob `Not found: <path>`
   when the VFS has no such file. That is the demo's equivalent of the server's JSON 404 in a
   PDF tab (feature.md edge case "cited user file is missing"). Keep; cover with a test.
5. **Seed has no PDF and no file citation.** `demo/seed/rust-ownership/sources/` holds only
   `rust-ownership-notes.md`; every seed footnote is `sources/rust-ownership-notes.md:a-b`.
   The only user file (`mutable-references/files/my-attempt.md`) is mentioned inline in
   backticks, never cited. `seed.ts` bundles `demo/seed/**/*` with `import.meta.glob(...,
   { query: '?raw' })` and `vfs.reset` writes every entry with `writeText` (UTF-8), so a seed
   PDF must be **pure ASCII** (`%PDF-` … with LF line endings) to survive byte-exactly; PDF
   allows that (uncompressed content streams, standard Helvetica). Both browser viewers
   rebuild a slightly-off xref table, but the implementer should emit correct offsets anyway.
6. **Simulated answers never cite anything.** `questions.ts` `run()` streams
   `loremAnswer(random)` (prose paragraphs and a list, no footnotes). To show the feature on
   fresh questions, the simulation appends footnotes in the contract's forms.
7. **`exportsComplete` guard.** The contract keeps `sourceUrl` / `userFileUrl` /
   `nodeFileUrl` / `attachmentUrl` signatures unchanged and adds no `api` method; the text
   viewer for user files is expected to use the existing `api.getAttachmentText(tree, node,
   name, 'files')` (already mocked, `folder` honoured). No shim change is expected. The
   compile-time guard (`type Missing = Exclude<keyof typeof Real, keyof typeof
   import('./client')>` and `api: typeof Real.api`) makes `pnpm --filter @otago/demo lint`
   fail if the web plan adds an export or an `api` method; then add the mock counterpart
   (see step 7).

## Files

| File | Change |
|---|---|
| `demo/src/mock/demo.ts` | `nfc(file)` in `getSourceText`, `deleteSource` and `urls.source` (contract decision 6 / server NFC hardening). Pass the new citation helper's needs to `Questions` if it reads sources through `TreeStore` (it already has `trees`; no new option expected). |
| `demo/src/mock/cite.ts` (new) | Pure helpers for simulated footnotes (no I/O): `pdfPageCount(bytes)` (count `/Type /Page` objects, not `/Pages`; 0 when none found, e.g. compressed object streams), `textLineCount(text)`, `pickRange(random, max, unit)` (start ≥ 1, end ≥ start, end ≤ max; max 0 → `:1`), `withCitations(answer, refs, random)`: inserts `[^n]` chips at the end of prose sentences (never immediately before a `:`; never inside fenced code or list items) and appends `\n\n[^1]: <ref>[ (<comment>)]\n…` definitions. Comment = 2–4 lorem words in parentheses, always for PDF refs (the showcase), ~50 % otherwise. Ref forms produced, exactly per contract `citations.ts` §2: `sources/<name>:<a>-<b>`, `sources/<name>.pdf:<p>-<q>`, `files/<name>:<a>-<b>`, `<node id>/files/<name>:<a>-<b>`, and `files/<image>` without a range (unit `none`). Ref first, digits only, one ref per footnote. |
| `demo/src/mock/questions.ts` | In `run(entry)`: build the candidate refs and pass the answer through `withCitations`. Candidates: up to one `.pdf` source and one `.md`/`.txt` source of the tree (`trees.listSources` + `trees.readSource` for page/line counts), up to one of the question's own files (`entry.files`: `.md`/`.txt` lines, `.pdf` pages, image no range) and up to one user file of an ancestor node (`trees.chain(tree, parentId)` → first node with `files`, cited as `<node id>/files/<name>:a-b`). Deterministic with the injected `random`. Retry regenerates (as today). Nothing else changes (naming, commit with `entry.files`, remaps). |
| `demo/src/mock/lorem.ts` | Export the word pool / `sentence` helper if `cite.ts` reuses them for comments (small refactor, no behaviour change). |
| `demo/seed/rust-ownership/sources/rust-book-ch04-ownership.pdf` (new) | Hand-built ASCII-only PDF, 4 pages, Helvetica, one heading plus a few lines each: p1 cover ("The Rust Programming Language - Chapter 4: Understanding Ownership"), p2 "4.1 What Is Ownership?" with the three rules and the `String` example, p3 "4.2 References and Borrowing" with the two rules, p4 "4.2 Mutable references and dangling references". ASCII only (no em dashes, no curly quotes), LF line endings, correct xref offsets. Size ~2–3 KB. |
| `demo/seed/rust-ownership/tree.md` | Instruction line: also cite `sources/rust-book-ch04-ownership.pdf` by page. |
| `demo/seed/rust-ownership/what-is-ownership/node.md` | Add a chip and `[^2]: sources/rust-book-ch04-ownership.pdf:1-2 (cover and the three ownership rules)` — the screenshot form (range + trailing comment). |
| `demo/seed/rust-ownership/what-is-ownership/borrowing-rules/node.md` | Add `[^3]: sources/rust-book-ch04-ownership.pdf:3-4 (the two borrowing rules)` with a chip in the prose. |
| `demo/seed/rust-ownership/what-is-ownership/borrowing-rules/dangling-references/node.md` | Add `[^2]: sources/rust-book-ch04-ownership.pdf:4` (single page, no comment) with a chip. |
| `demo/seed/rust-ownership/what-is-ownership/borrowing-rules/mutable-references/node.md` | Add a chip after "both stay alive until the `println!`" and `[^2]: files/my-attempt.md:6-7 (the two &mut borrows)` (lines 6–7 of `files/my-attempt.md` are the two `&mut` borrows). The chip must not directly precede a colon (seed test rule). |
| `demo/seed/rust-ownership/what-is-ownership/borrowing-rules/mutable-references/scoped-borrows/node.md` (new, optional) | A short child answer ("Does the fix still work if I keep both pushes?") that cites the parent's file by node id: `[^1]: what-is-ownership/borrowing-rules/mutable-references/files/my-attempt.md:8-9 (both pushes)`. Shows the `<node id>/files/` form resolving across nodes. `created` after the parent's. |
| `demo/src/mock/demo.test.ts` | Tests below. |
| `demo/src/mock/questions.test.ts` | Tests below. |
| `demo/src/mock/cite.test.ts` (new) | Tests below. |
| `demo/src/mock/seed.test.ts` | Extend the citation check to the new forms and units (below). |
| `CLAUDE.md` (Demo section, one or two lines) | Seed PDFs must be ASCII-only (`?raw` bundling); the demo page must never get a CSP with `sandbox` (blob PDF tabs inherit it). |

No data-model changes (VFS format `v: 1` unchanged; PDFs are ordinary files). No interface
changes: `demo/src/mock/client.ts` exports stay as they are unless the web plan changes
`web/src/api/client.ts` (step 7). No generated files.

Returning visitors keep their old VFS (the seed is written only when storage is empty); the
new seed shows after "Reset" in the demo banner. Existing behaviour for every seed change;
no versioning added.

## Step order

1. `demo.ts`: NFC on `getSourceText`, `deleteSource`, `urls.source`. Add the `demo.test.ts`
   NFC and blob-type tests; run `pnpm --filter @otago/demo test -- src/mock/demo.test.ts`.
2. `cite.ts` + `cite.test.ts` (pure, no VFS). Validate every produced definition line against
   a local copy of contract `PROMPT_EXAMPLE_FOOTNOTE_RE` (comment: "mirrors
   contracts/prompt.ts"), the same invariant the server test uses on `SYSTEM_RULES`.
3. `questions.ts`: wire `withCitations` into `run()`; add the `questions.test.ts` cases.
   Existing cases must stay green (`nodeId` naming, chunk contiguity, fail/retry, remaps).
4. Seed: build `rust-book-ch04-ownership.pdf` (a one-off script computing xref offsets is fine;
   commit only the PDF), edit the four `node.md` files (+ optional `scoped-borrows`), `tree.md`.
   Extend `seed.test.ts`; run `pnpm --filter @otago/demo test -- src/mock/seed.test.ts`.
5. `pnpm check` (Biome; never hand-format), `pnpm --filter @otago/demo lint` (includes the
   `exportsComplete` guard and `tsc`), `pnpm --filter @otago/demo test`, `pnpm --filter
   @otago/demo build`.
6. Manual check after the web implementation lands (`pnpm demo`, Chromium + Firefox + Safari,
   after "Reset"): in "What is ownership" click chip `[2]` and the source-list row → a new tab
   with the ASCII PDF on page 1–2 (`blob:…#page=1`); in "borrowing-rules" `[3]` → page 3; in
   "mutable-references" `[2]` → in-app viewer of `files/my-attempt.md` scrolled to line 6,
   lines 6–7 highlighted, comment shown muted; upload a real PDF as a source and ask a
   question → the simulated answer's PDF footnote opens it at the cited page; attach a `.md`
   to a question → the `files/<name>:a-b` row is inert while streaming and opens the viewer
   after save. Also verify the `window.open(blobUrl + '#page=3', '_blank',
   'noopener,noreferrer')` variant (whatever the web plan picks) lands on page 3 in Chromium;
   if `noopener` ever interferes with blob navigation, the fix belongs to the web's single
   "open target" helper, not to the demo.
7. If `pnpm --filter @otago/demo lint` fails on `exportsComplete` or `api: DemoApi` after the
   web change: add the missing export/method to `client.ts` / `demo.ts` with the mock's
   semantics (e.g. a text fetch of a user file maps to `trees.readNodeFileContent(id, nfc(node),
   'files', name)` decoded as UTF-8). Expected: no change.

## Test plan

`demo/src/mock/demo.test.ts` (`describe('demo api: sources and urls')`):
- "serves PDFs as application/pdf blob URLs that keep working with a page fragment": write
  `t/sources/guide.pdf` (ASCII `%PDF-…`) via `demo.vfs.transaction(writeText)` or
  `uploadSource(new File([...], 'guide.pdf'))`; `const url = demo.urls.source('t',
  'guide.pdf')`; `fetch(url)` → `content-type` `application/pdf`, body starts with `%PDF-`;
  `fetch(`${url}#page=3`)` resolves to the same body (fragment never reaches the "server").
  Node's fetch resolves `blob:` URLs (checked on Node 24; vitest runs in the `node`
  environment, no config file). A `.md` source → `text/markdown; charset=utf-8`.
- "normalizes source names to NFC like the server": upload an NFC Cyrillic `.pdf` name;
  `getSourceText('t', name.normalize('NFD'))` resolves; `urls.source('t', nfd) ===
  urls.source('t', nfc)`; `deleteSource('t', nfd)` deletes it.
- "user files: blob typed by name, missing file is a text/plain not-found blob": write
  `t/a/files/report.pdf`; `urls.nodeFile('files', 't', 'a', 'report.pdf')` → fetch gives
  `application/pdf`; `urls.nodeFile('files', 't', 'a', 'nope.pdf')` → `text/plain`, body
  `Not found: t/a/files/nope.pdf` (the demo's "404 in the PDF tab").

`demo/src/mock/cite.test.ts`:
- `pdfPageCount`: 3 for a 3-page ASCII PDF, 0 for `%PDF-1.7` with only `/Type /Pages`, 0 for
  garbage; `textLineCount` ignores a trailing newline.
- `withCitations`: with a fixed `random`, output ends with a blank line + definition lines; a
  PDF ref has `:p-q` within the page count and a parenthesised comment; a text ref has a line
  range within the line count; an image user file is cited as `files/<name>` without a range;
  an ancestor file as `<node id>/files/<name>:a-b`; every definition line matches the local
  `PROMPT_EXAMPLE_FOOTNOTE_RE` copy (except the no-range image form, asserted separately);
  every `[^k]` chip has a definition and vice versa; no chip directly precedes `:`; chips
  are never inside fenced code; `withCitations(answer, [], random) === answer`.

`demo/src/mock/questions.test.ts`:
- "answers cite the tree's sources and the message's files with machine-readable footnotes":
  add `t/sources/guide.pdf` (3 pages) to the VFS; start a question with `files:
  [new File(['one\ntwo\nthree\n'], 'draft.md')]`; `runAllTimersAsync`; read the saved node
  via `getChain`; assert definition lines for `sources/guide.pdf:<p>(-<q>)? (<comment>)` with
  `q ≤ 3`, `sources/notes.md:1` (the `SMALL_SEED` note has one line), `files/draft.md:<a>-<b>`
  with `b ≤ 3`; all definitions match the `PROMPT_EXAMPLE_FOOTNOTE_RE` copy; the streamed
  chunks concatenate to the same text (existing contiguity assertion reused).
- "cites an ancestor's user file by node id": write `t/a/files/spec.txt` (2 lines) and ask
  under `a/b`; the answer has `[^k]: a/files/spec.txt:<a>(-<b>)?`.
- Integration (after the web parser lands; skip if importing `web/src/lib/citations.ts` into
  the demo test proves heavy because of its `../i18n` import — it is guarded for non-browser
  environments): `extractCitations(assistant).citations` yields targets `{ kind: 'source',
  file: 'guide.pdf', start, end, comment }`, `{ kind: 'source', file: 'notes.md', start: 1 }`,
  `{ kind: 'file', node: undefined, name: 'draft.md', start, end }` and
  `{ kind: 'file', node: 'a', name: 'spec.txt' }`. This is the proof that the SAME web code
  resolves the mock's citations.
- Existing tests unchanged in intent; `SMALL_SEED` answers now end with `[^1]:
  sources/notes.md:1`, which no current assertion contradicts (`assistant === answer.trim()`
  still holds).

`demo/src/mock/seed.test.ts`:
- Replace the `sources/([\w.-]+):(\d+)` scan with a scan of definition lines
  (`/^\[\^[^\]\s]+\]: (.*)$/m`) and the contract regexes copied locally (`SOURCE_REF_RE`,
  `FILE_REF_RE` from `contracts/citations.ts`): for `.md`/`.txt` sources `end ≤ line count`;
  for `.pdf` sources `end ≤ pdfPageCount(bytes)`; for `files/` refs the file exists on the
  answer's own node, for `<node id>/files/` refs on that node, and the range is within the
  file's lines/pages. Every chip has a definition and vice versa; the existing "no chip
  before a colon" rule stays.
- Showcase guard: at least one seed footnote is a `.pdf` page ref with a comment, and at
  least one is a `files/<name>:a-b` ref (fails if someone later trims the seed).
- Seed PDFs: every `demo/seed/**/*.pdf` entry starts with `%PDF-`, is ASCII-only
  (`/^[\x09\x0a\x0d\x20-\x7e]*$/`), contains no `\r`, and `pdfPageCount ≥ 1`. This is what
  makes `?raw` + `writeText` byte-safe.

Out of scope for the demo (web plan): parser, `CitationTarget.comment`, open-target logic,
labels/i18n, viewer scrolling, the inert rendering of `files/` refs while streaming.
