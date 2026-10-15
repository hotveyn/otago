# Server plan — clickable-citations

Project: `server` (`@otago/server`, Fastify + Zod, `server/src`). Contract owner.
Contract: `.claude/features/clickable-citations/contracts/` (`index.ts`, `shared.ts`,
`citations.ts`, `file-routes.ts`, `prompt.ts`). Web and demo plan against it.

## Scope and conclusions

Expected scope was (1) prompt wording, (2) verify the file routes, (3) a prompt test. Result:

1. **Prompt** (`server/src/agent/prompt.ts` `SYSTEM_RULES`): rule 2 and the "User files"
   bullet are rewritten so that PDF citations are page numbers, text citations stay line
   numbers, the reference comes first and commentary after it (contract `prompt.ts` R1–R9).
2. **File routes — one gap found, so one behaviour change is needed.** `GET /trees/:tree/files`
   (and `/attachments`, same helper `fileResponseHeaders`) send
   `Content-Security-Policy: … sandbox`. Chromium refuses to run its built-in PDF viewer in a
   sandboxed document (already documented in the rich-answers web plan R1; `AttachmentViewer`
   previews PDFs via a blob URL because of it). Opening `userFileUrl(...)#page=N` in a new tab
   therefore shows a blocked plugin in Chromium, and a blob workaround is impossible because
   the tab must open synchronously from the click (pop-up blockers). Decision (contract
   `file-routes.ts`, index decision 2): **omit the CSP header when the content type is
   `application/pdf`**; all other types keep the full CSP, `nosniff` stays. The sources route
   already serves PDFs with no CSP and inline (no `Content-Disposition`), which is exactly what
   `#page=` needs — unchanged.
   Small hardening on the sources route: normalize `:file` to NFC like the other route
   schemas (a citation copied from NFD text still resolves).
   No new endpoint, no new query parameter, no change to URL recipes; `#page=` is a client-only
   fragment.
3. **Tests**: prompt phrases + an invariant that every example footnote in `SYSTEM_RULES`
   parses with the contract grammar; header tests for the PDF CSP exemption; NFC test for the
   sources route.

Prerequisite already in the working tree (uncommitted, not part of this feature, keep it):
Unicode source names (`server/src/storage/source-names.ts`, `sources.ts`, `routes/sources.ts`
NFC on upload, tests). The contract's source-name alphabet is copied from it.

## Files

| File | Change |
|---|---|
| `server/src/agent/prompt.ts` | Rewrite rule 2 of `SYSTEM_RULES` and the "Cite a user file…" bullet (wording below). Nothing else in the file. |
| `server/src/routes/file-headers.ts` | `fileResponseHeaders`: do not add `content-security-policy` when `contentType === 'application/pdf'`. Export the exemption as a constant (e.g. `CSP_EXEMPT_CONTENT_TYPES = ['application/pdf']`) with a comment explaining the Chromium sandbox/PDF-viewer reason. |
| `server/src/routes/sources.ts` | `fileParams`: `file: z.string().normalize('NFC')` (consistent with `schemas.ts`; the `.max()` is not needed, `assertSourceName` already bounds it). |
| `server/test/agent.test.ts` | New tests in `describe('prompt building')` / `describe('user files in prompts')` (test plan below). |
| `server/test/question-files-api.test.ts` | Extend the "serves a user file inline or as a download with safe headers" test: a `.pdf` user file has no `content-security-policy` header (inline and `download=1`), content-type `application/pdf`, disposition inline; a non-PDF still has the full CSP. |
| `server/test/attachments-api.test.ts` | Same assertion for a `.pdf` attachment (same helper). |
| `server/test/sources-api.test.ts` | `GET` with the NFD form of a stored NFC name returns 200 (and 404 for a name that exists in neither form). |
| `README.md` (line 28, optional) | "cites file and line numbers" → "cites file and line numbers (pages for PDFs)". |
| `CLAUDE.md` (optional, one line) | In the Server section: file routes serve PDFs without the sandboxing CSP so the native viewer can open them at `#page=N`. |

No new files. No data-model changes. No generated files. No migrations.

## Prompt wording (suggested; must satisfy contract `prompt.ts` R1–R9)

Rule 2 replaces the current two-form sentence + example:

```
2. Cite every fact with a Markdown footnote. A footnote starts with one reference, optionally followed by a short comment on the same line:
   - text files (`.md`, `.txt`, extracted e-book text): `sources/<file>:<start>-<end>` with line numbers;
   - PDFs: `sources/<file>.pdf:<first page>-<last page>` with the page numbers shown by Read (PDFs have no line numbers);
   - the web: the URL.
   Use the file name exactly as it is on disk, digits only in the range, one reference per footnote, nothing before the reference. Example:
   Borrowing lets you reference a value without taking ownership [^1]. The chapter opens with a summary [^2].

   [^1]: sources/the-book-ch4.md:120-134
   [^2]: sources/the-book.pdf:35-37 (chapter summary)
```

"User files" bullet:

```
- Cite a user file like a source: `files/<name>:<start>-<end>` for the current message, `<node-id>/files/<name>:<start>-<end>` for earlier messages (page numbers for `.pdf`, line numbers otherwise). Never mention the temporary `.tmp-answer-…` path in the answer.
```

Keep every phrase the existing tests assert (`sources/`, `Cite`, `files/<name>`,
`<node-id>/files/`, `.tmp-answer-`, `attachments/…`, trash/staging sentences). Rule 1's
e-book sentence already says to cite `sources/<book file>.md`; leave it.

## Interface changes (summary for web/demo)

- Citation grammar: contract `citations.ts` (footnote forms F1–F10, `SOURCE_REF_RE`,
  `FILE_REF_RE`, units by extension, comment extraction, `CitationTarget` with `file` kind and
  `comment`, open actions, 35-row conformance table that the web tests must cover).
- `GET /api/trees/:tree/files` and `/attachments`: PDF responses lose the CSP header. Nothing
  else changes (headers, 404 shapes, URL recipes as before).
- `GET /api/trees/:tree/sources/:file`: `:file` NFC-normalized server-side; behaviour otherwise
  unchanged (inline, no CSP, 404 `Source not found`).

## Step order

1. `prompt.ts`: rewrite rule 2 and the user-files bullet (wording above).
2. `agent.test.ts`: add the prompt tests; run `pnpm --filter @otago/server test -- test/agent.test.ts`
   (existing phrase tests must still pass).
3. `file-headers.ts`: CSP exemption for `application/pdf`; update
   `question-files-api.test.ts` and `attachments-api.test.ts`.
4. `routes/sources.ts`: NFC on `:file`; add the `sources-api.test.ts` case.
5. Docs lines (README / CLAUDE.md), optional.
6. `pnpm check` (Biome, never hand-format), `pnpm --filter @otago/server lint`,
   `pnpm --filter @otago/server test`.
7. Manual check (dev server, Chromium + Firefox + Safari): upload a PDF as a source and as a
   message file; open `/api/trees/<t>/sources/<f>.pdf#page=3` and
   `/api/trees/<t>/files?node=<n>&name=<f>.pdf#page=3` in a new tab — the native viewer must
   render and (except Safari) land on page 3. This confirms decision 2 before the web relies
   on it; if Chromium still blocks the viewer with no CSP at all, report back (the fallback
   would be a dedicated CSP without `sandbox`, still inside `fileResponseHeaders`).

## Test plan

`server/test/agent.test.ts` (no SDK calls; pure string checks like the existing ones):
- "cites PDF pages and text lines, reference first": `SYSTEM_RULES` contains each of
  contract `PROMPT_REQUIRED_PHRASES` (`sources/<file>:<start>-<end>`,
  `sources/<file>.pdf:<first page>-<last page>`, `page numbers`, `line numbers`,
  `files/<name>:<start>-<end>`, `<node-id>/files/<name>:<start>-<end>`).
- "every example footnote in the rules is machine-readable": collect lines of `SYSTEM_RULES`
  matching `/^\s*\[\^[^\]]+\]:/`, expect at least two (one `.md` with lines, one `.pdf` with
  pages and a comment), and expect each trimmed line to match a local copy of contract
  `PROMPT_EXAMPLE_FOOTNOTE_RE` (comment: "mirrors contracts/prompt.ts").
- Existing "lists all six rules" / "explains user files in the system rules" stay green.
- Naming: `namingExcerpt` still drops a definition with a comment
  (`[^2]: sources/a.pdf:1-4 (cover)` → nothing of it in the excerpt); add the case to the
  existing "keeps prose and drops code, links, footnotes…" test.

`server/test/question-files-api.test.ts`:
- `.pdf` user file served inline: `content-type: application/pdf`, disposition `inline; …`,
  `x-content-type-options: nosniff`, **no** `content-security-policy`; with `download=1`:
  `attachment; …`, still no CSP. A `.txt`/`.png` file keeps the full CSP (existing assertion).
- `.epub` user file: companion `.md` keeps the CSP (text), the binary keeps it too.

`server/test/attachments-api.test.ts`:
- A `.pdf` attachment: no CSP header; an `.svg`/`.html` attachment: CSP present (existing).

`server/test/sources-api.test.ts`:
- Upload `café notes.md` (NFC stored); `GET` with the NFD-encoded name → 200 with the same
  body; `GET` of a `.pdf` has `application/pdf`, no `content-disposition`, no CSP (documents
  the inline behaviour the web relies on).

Out of scope for the server (web/demo plans): parser/`CitationTarget` changes, viewer
behaviour, `#page=` construction, labels/i18n, demo seed footnotes.
