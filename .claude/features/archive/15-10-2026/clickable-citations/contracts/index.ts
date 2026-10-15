/**
 * CONTRACT SPEC (planning artifact) — feature `clickable-citations`. Owner: server.
 * Single source of truth for the citation grammar and the file-serving behaviour during
 * planning. Hand-authored TypeScript; NOT a runtime module and not generated. There is no
 * codegen in this repo: the server implements the prompt side in `server/src/agent/prompt.ts`
 * and the header side in `server/src/routes/file-headers.ts` / `server/src/routes/sources.ts`;
 * the web implements the parser in `web/src/lib/citations.ts` and the "open target" logic in
 * one place (`web/src/components/chat/Markdown.tsx` or a new `web/src/lib/open-citation.ts`);
 * the demo mock (`demo/src/mock/`) reproduces the file-serving semantics with blob URLs.
 *
 * Files:
 *  - shared.ts        existing shapes reused: ErrorBody, name grammars (source names, user
 *                     file names, node ids), e-book text companions, content types
 *  - citations.ts     what the agent writes and the web parses: footnote forms, reference
 *                     grammar (`sources/…`, `files/…`, `<node id>/files/…`, URL), unit
 *                     semantics (pages vs lines), comment extraction, target model, open
 *                     actions, conformance examples
 *  - file-routes.ts   the two GET endpoints the client opens (sources, user files): paths,
 *                     query, Content-Type / Content-Disposition / CSP behaviour (incl. the
 *                     ONE server change: no sandboxing CSP on PDF responses), 400/404 shapes,
 *                     URL recipes with the `#page=` fragment, client + demo obligations
 *  - prompt.ts        server-internal: what the system prompt must tell the agent so that
 *                     footnotes stay machine-readable, and the invariant the server tests
 *
 * Decisions (feature.md goals, edge cases and NFRs), binding for server, web and demo:
 *  1. No new API. The existing `GET /api/trees/:tree/sources/:file` and
 *     `GET /api/trees/:tree/files?node=&name=[&download=1]` are reused. Page positioning is a
 *     client-only URL fragment (`#page=N`), never sent to the server.
 *  2. ONE server behaviour change (gap found while verifying decision 1): user-file and
 *     attachment responses with `Content-Type: application/pdf` are sent WITHOUT the
 *     `content-security-policy` header. The current CSP contains `sandbox`, and Chromium
 *     refuses to run its PDF viewer in a sandboxed document (known since rich-answers; the
 *     web previews attachment PDFs through blob URLs for that reason). Opening
 *     `userFileUrl(...)#page=N` in a new tab needs the native viewer, and the tab must open
 *     synchronously from the click (pop-up blockers), so a blob workaround is not possible.
 *     The sources route sends no CSP today and keeps sending none. Non-PDF files keep the
 *     full sandboxing CSP.
 *  3. Units: `.pdf` citations are PAGE numbers (the agent reads PDFs page by page with the
 *     SDK `Read` tool; PDFs are not text-extracted). Everything else is LINE numbers,
 *     including the extracted `.md` text of e-books. A citation of the e-book binary itself
 *     (`sources/book.epub:12-20`) is tolerated and resolves to `book.epub.md` (lines).
 *  4. A footnote is `<ref>` optionally followed by free text (the comment). The ref MUST be
 *     at the start (after optional wrapping: backticks, `<…>`, `[label](…)`). Text with a ref
 *     in the middle, or with a ref that does not match the grammar, stays `text`.
 *  5. `files/<name>` (no node id) means the answer's own node; it is resolvable only once the
 *     answer is saved (the renderer knows the node id). While streaming it renders inert.
 *  6. Node ids and file names parsed from a citation are normalized to NFC before building a
 *     URL (as every id read from the URL bar is). The sources route additionally normalizes
 *     `:file` to NFC on the server (small hardening, consistent with the other schemas).
 *  7. Future seams (feature.md): `CitationTarget` stays open to `fragment` / `quote` fields
 *     (text fragments for URLs, in-PDF text highlight, quoted-fragment highlight in text) and
 *     a future `<name>.pdf.md` extraction would turn PDF citations into line citations of the
 *     companion without changing the grammar (the unit is derived from the cited file name).
 */
export * from './citations';
export * from './file-routes';
export * from './prompt';
export * from './shared';
