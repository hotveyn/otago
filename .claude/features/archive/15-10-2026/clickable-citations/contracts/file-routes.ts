/**
 * CONTRACT SPEC (planning artifact) — feature `clickable-citations`. Owner: server.
 * The file-serving routes a citation click opens. Both EXIST; this feature changes ONE header
 * behaviour (PDF responses of the node-file routes) and adds NFC normalization of `:file` on
 * the sources route. All paths are under `/api`. JSON errors use ./shared.ts `ErrorBody`.
 */
import type { ErrorBody, FileRouteNotFoundCode, NodeId, SourceContentType, UserFileContentType } from './shared';

/* ---------------------------------------------------------------------------------------
 * GET /api/trees/:tree/sources/:file                                       (EXISTING)
 *
 * `:file` = the stored source name, percent-encoded UTF-8 (`encodeURIComponent`). The server
 * decodes it and (CHANGE, small) normalizes it to NFC before validation, like every node id /
 * name in the other route schemas, so a citation copied from NFD text still resolves.
 *
 * 200: body = the whole file (buffered). Headers:
 *   content-type    `SourceContentType` by extension (`application/pdf`, `text/markdown;
 *                   charset=utf-8`, `text/plain; charset=utf-8`, e-book MIME types)
 *   content-length  set by Fastify
 *   NO content-disposition → browser default is inline: a PDF renders in the tab with the
 *                   native viewer, text shows as text, e-book binaries download. Unchanged.
 *   NO content-security-policy on this route (unchanged; the tree owner uploaded the file).
 *   No `download` query on this route (unchanged; the viewer's "book" link uses the anchor
 *   `download` attribute).
 * 400 `{ error: 'Invalid source file name: <name>' }`  name outside the grammar, `..`,
 *     unsupported extension (also for `GET`; the name is validated before the read)
 * 404 `{ error: 'Tree not found: <tree>', code: 'tree_not_found' }`
 * 404 `{ error: 'Source not found: <name>' }`           no `code` (unchanged)
 * Read-only: not blocked by the tree lock (unchanged).
 * ------------------------------------------------------------------------------------- */

export interface GetSourceRoute {
  params: { tree: string; file: string };
  response: { status: 200; contentType: SourceContentType; body: Uint8Array };
  errors:
    | { status: 400; body: ErrorBody }
    | { status: 404; body: ErrorBody & { code?: Extract<FileRouteNotFoundCode, 'tree_not_found'> } };
}

/* ---------------------------------------------------------------------------------------
 * GET /api/trees/:tree/files?node=<node id>&name=<file>[&download=1]        (EXISTING)
 *
 * Serves one user file (or an e-book's `.md` companion) of a COMMITTED node. Query values are
 * percent-encoded UTF-8; `node` is normalized to NFC by the schema; `name` is ASCII
 * (USER_FILE_NAME_RE) and validated (400 `{ error: 'Invalid file name: <name>' }`).
 *
 * 200: body streamed. Headers (`fileResponseHeaders` in `server/src/routes/file-headers.ts`,
 * shared with `GET /api/trees/:tree/attachments`):
 *   content-type              `UserFileContentType` (`userFileContentTypeOf`)
 *   content-length            file size
 *   content-disposition       `inline; filename="<name>"; filename*=UTF-8''<name>` or, with
 *                             `download=1`, `attachment; …`
 *   x-content-type-options    `nosniff`
 *   cache-control             `no-cache`
 *   content-security-policy   `default-src 'none'; img-src data:; style-src 'unsafe-inline';
 *                             sandbox`  — EXCEPT for PDFs, see the CHANGE below
 * 400 `{ error: 'Invalid file name: <name>' }` / Zod `Invalid input` for a bad query
 * 404 `{ error: 'Tree not found: <tree>', code: 'tree_not_found' }`
 * 404 `{ error: 'Node not found: <node>', code: 'node_not_found' }`  (deleted / renamed node)
 * 404 `{ error: 'File not found: <name>' }`                           no `code` (unchanged)
 * Read-only: not blocked by the tree lock (unchanged).
 *
 * CHANGE (the one server behaviour change of this feature):
 *   When the served content type is `application/pdf`, the `content-security-policy` header
 *   is NOT sent (regardless of `download`). Every other content type keeps the full CSP above.
 *   Reason: the CSP `sandbox` directive makes Chromium refuse to run its built-in PDF viewer
 *   ("blocked plugin"), so `window.open(userFileUrl(...) + '#page=N')` would show nothing;
 *   and the tab must be opened synchronously from the click, so fetching bytes into a blob
 *   first (the AttachmentViewer workaround) is not an option. The sources route has never sent
 *   a CSP for PDFs and the native viewer works there. A PDF cannot script the page origin;
 *   the sandbox exists for HTML/SVG/… user files, which keep it. `nosniff` stays.
 *   Applies to both `/files` and `/attachments` (same helper), so attachment PDFs may later
 *   drop the blob preview too (not required by this feature).
 * ------------------------------------------------------------------------------------- */

export interface UserFileQuery {
  node: NodeId;
  name: string;
  download?: '1';
}

export interface GetUserFileRoute {
  params: { tree: string };
  query: UserFileQuery;
  response: { status: 200; contentType: UserFileContentType; body: ReadableStream };
  errors:
    | { status: 400; body: ErrorBody }
    | { status: 404; body: ErrorBody & { code?: FileRouteNotFoundCode } };
}

/** Header table of `fileResponseHeaders(name, size, contentType, download)` after the change. */
export interface FileResponseHeaders {
  'content-type': string;
  'content-length': string;
  'content-disposition': `inline; filename="${string}"; filename*=UTF-8''${string}` | `attachment; filename="${string}"; filename*=UTF-8''${string}`;
  'x-content-type-options': 'nosniff';
  'cache-control': 'no-cache';
  /** Present unless `content-type` is `application/pdf`. */
  'content-security-policy'?: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
}

export const FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
/** Content type that is served without FILE_CSP. */
export const CSP_EXEMPT_CONTENT_TYPES: readonly string[] = ['application/pdf'];

/* ---------------------------------------------------------------------------------------
 * URL recipes (web `web/src/api/client.ts`, unchanged signatures; the demo shim must export
 * the same names and return blob URLs):
 *
 *   sourceUrl(tree, file)                 = `/api/trees/${enc(tree)}/sources/${enc(file)}`
 *   userFileUrl(tree, node, name, dl?)    = `/api/trees/${enc(tree)}/files?node=${enc(node)}
 *                                            &name=${enc(name)}${dl ? '&download=1' : ''}`
 *   enc = encodeURIComponent; `file`, `node`, `name` NFC-normalized by the caller.
 *
 * Page positioning: `<url>#page=<start>` (./citations.ts PDF_PAGE_FRAGMENT). A fragment is
 * never sent to the server; the server has nothing to implement for it. Honoured by the
 * Chromium/Edge and Firefox (pdf.js) viewers; Safari ignores it (page 1) — accepted. For the
 * demo's blob URLs, `blob:…#page=N` works in Chromium (feature.md NFR).
 *
 * Client obligations (web), for planning against this contract:
 *  - PDF targets (unit `page`): open `sourceUrl`/`userFileUrl` + fragment in a new tab from
 *    the click handler synchronously (anchor `target="_blank" rel="noopener noreferrer"` with
 *    a precomputed `href`, or `window.open` before any `await`). Do not fetch first.
 *  - Text targets (unit `line`): keep fetching the text (`useSourceText` for sources; a user
 *    file variant fetching `userFileUrl`) and render the in-app line viewer. E-book names map
 *    to their `.md` companion before fetching.
 *  - 404 handling: the in-app viewer shows its usual not-found error (`ErrorNote`); a PDF tab
 *    shows the server's JSON 404 as is (accepted, feature.md edge case).
 *  - Unit `none` targets (images and other user files): open inline in a new tab, same URL.
 *
 * Demo mock obligations (`demo/src/mock/`):
 *  - `sourceUrl`/`userFileUrl` keep returning blob URLs typed with the right MIME
 *    (`application/pdf` for `.pdf`), so `#page=` positioning works for seeded/uploaded PDFs.
 *  - No CSP exists in the mock; nothing to change for decision 2.
 *  - Seed answers in `demo/seed/` may include footnotes in the new forms (PDF page refs with a
 *    comment, user-file refs) so the demo shows the feature; see the demo plan.
 * ------------------------------------------------------------------------------------- */
export type ClientObligations = never;
