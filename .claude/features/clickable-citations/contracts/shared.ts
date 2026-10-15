/**
 * CONTRACT SPEC (planning artifact) — feature `clickable-citations`. Owner: server.
 *
 * Existing shapes this feature builds on, copied for reference from the implementation and
 * earlier contracts (`parallel-questions`, `chat-file-attachments`). UNCHANGED by this
 * feature unless a comment says otherwise.
 */

/**
 * JSON error body of every non-2xx JSON response (central error handler in
 * `server/src/app.ts`). `code` / `details` are omitted when absent. Unchanged.
 */
export interface ErrorBody {
  /** Human-readable, safe to show. */
  error: string;
  code?: string;
  details?: unknown;
}

/** Codes of the 404s the file routes can answer with (`server/src/errors.ts`). Unchanged. */
export type FileRouteNotFoundCode = 'tree_not_found' | 'node_not_found';

/* ---------------------------------------------------------------------------------------
 * Names. The citation grammar (./citations.ts) is built from these three alphabets.
 * ------------------------------------------------------------------------------------- */

/**
 * Source file name (`sources/<name>`), `server/src/storage/source-names.ts` (currently an
 * uncommitted change in the working tree; this feature plans on top of it). Starts with a
 * letter or digit; then letters, combining marks, digits, `.`, `_`, `-`, SPACE, `,`, `(`, `)`,
 * `'`, `’`, `+`, `&`. Never `/`, `\`, `:`, control chars, `\p{Cf}`. No `..`, no trailing
 * space or dot, ≤ 200 code points, ≤ 240 UTF-8 bytes. Stored and served in NFC.
 * NOTE for the parser: a source name may contain spaces and parentheses, so a `sources/…`
 * ref without a range is delimited by its extension (./citations.ts), not by whitespace.
 */
export const SOURCE_NAME_RE = /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}._ ,()'’+&-]{0,199}$/u;

/** Source extensions accepted by upload (`server/src/storage/sources.ts`). */
export const TEXT_SOURCE_EXTENSIONS = ['.md', '.txt'] as const;
export const PDF_EXTENSION = '.pdf';
/** E-book binaries; each is stored next to its extracted text `<name>.md`. */
export const EBOOK_EXTENSIONS = ['.epub', '.fb2', '.fb2.zip', '.mobi', '.azw', '.azw3'] as const;
/** `book.epub` → `book.epub.md` (`ebookTextName`); same rule for user e-books. */
export const EBOOK_TEXT_SUFFIX = '.md';

/**
 * User file name (`<node>/files/<name>`), `server/src/storage/user-files.ts`
 * `USER_FILE_NAME_PATTERN` (= `ATTACHMENT_NAME_PATTERN`). ASCII only, no spaces, no `..`.
 * Always ends with an allowed extension, hence with a letter or digit.
 */
export const USER_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** User file extensions (`MESSAGE_FILE_EXTENSIONS`): text, pdf, e-books, images. */
export const USER_FILE_EXTENSIONS = [
  '.md',
  '.txt',
  '.pdf',
  ...EBOOK_EXTENSIONS,
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
] as const;

/**
 * Node id = `/`-joined folder names relative to the tree (`server/src/storage/node-names.ts`
 * `NODE_NAME_RE`): words of letters/marks/digits joined by single `-`; NFC, lowercase. A
 * segment is never `files`, `attachments` (reserved at every level) nor, at the root,
 * `sources` (reserved root names in `paths.ts`). Therefore `files/…` at the start of a ref is
 * never a node id, and `<node id>/files/<name>` splits unambiguously at the LAST `/files/`
 * (a node segment cannot be `files`).
 */
export const NODE_SEGMENT_SOURCE = String.raw`[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*`;
export const NODE_ID_RE = new RegExp(`^${NODE_SEGMENT_SOURCE}(?:/${NODE_SEGMENT_SOURCE})*$`, 'u');
export type NodeId = string;

/* ---------------------------------------------------------------------------------------
 * Content types the two file routes answer with (unchanged; listed so the client can decide
 * "native viewer in a new tab" vs "in-app text viewer" from the NAME alone, without a HEAD).
 * ------------------------------------------------------------------------------------- */

/** `contentTypeOf` in `server/src/storage/sources.ts`. */
export type SourceContentType =
  | 'application/pdf'
  | 'text/markdown; charset=utf-8'
  | 'text/plain; charset=utf-8'
  | (string & {}); // e-book binaries: application/epub+zip, application/x-mobipocket-ebook, …

/** `userFileContentTypeOf`: e-book types, else the attachment table (`image/png`, …). */
export type UserFileContentType =
  | 'application/pdf'
  | 'text/markdown; charset=utf-8'
  | 'text/plain; charset=utf-8'
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif'
  | (string & {});
