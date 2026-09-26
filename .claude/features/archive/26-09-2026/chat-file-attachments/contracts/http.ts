/**
 * CONTRACT SPEC (planning artifact) — feature `chat-file-attachments`.
 * Other HTTP surface touched by this feature. All paths are under the `/api` prefix.
 */
import type { AttachmentInfo, ConflictCode, NodeId } from './shared';
import type { UserFileInfo } from './user-files';

/* ---------------------------------------------------------------------------------------
 * GET /api/trees/:tree/chain?node=<id>   — CHANGED (additive `files`)
 * ------------------------------------------------------------------------------------- */

export interface ChainNode {
  id: NodeId;
  name: string;
  created: string;
  model: string;
  /** User text as stored in node.md; may be `""` for a files-only message (new). */
  user: string;
  assistant: string;
  /** Agent files in `<node>/attachments/` (unchanged). */
  attachments: AttachmentInfo[];
  /**
   * NEW. User files in `<node>/files/`, sorted by name; `[]` for nodes without files
   * (all pre-existing nodes). Clients talking to an older server should default to `[]`.
   */
  files: UserFileInfo[];
}

export interface ChainResponse {
  chain: ChainNode[];
}

/* ---------------------------------------------------------------------------------------
 * GET /api/trees/:tree/files?node=<id>&name=<name>[&download=1]   — NEW
 *
 * Serves one user file (or an e-book's `.md` companion) of a committed node.
 * DECISION: query parameters (not `/nodes/:nodeId/files/:name`) because node ids contain `/`;
 * mirrors `GET /api/trees/:tree/attachments` exactly.
 *
 * - `node`: required, non-empty node id. `name`: 1..200 chars; must match USER_FILE_NAME_PATTERN
 *   (else 400). `download=1` → `content-disposition: attachment`, otherwise `inline`.
 * - Read-only, not blocked by the tree lock.
 * - Headers: `content-type` (UserFileInfo.contentType; companion → `text/markdown; charset=utf-8`),
 *   `content-length`, `content-disposition: <inline|attachment>; filename="<name>";
 *   filename*=UTF-8''<enc>`, `x-content-type-options: nosniff`,
 *   `content-security-policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`,
 *   `cache-control: no-cache`.
 * - 404: unknown tree, unknown node, missing file (or not a regular file).
 * - Staged (not yet committed) files are never reachable (the staging dir is not a node).
 * ------------------------------------------------------------------------------------- */

export interface UserFileQuery {
  node: NodeId;
  name: string;
  download?: '1';
}

/** URL recipe the web mirrors: `/api/trees/${tree}/files?node=${enc(node)}&name=${enc(name)}[&download=1]`. */
export type UserFileUrl = string;

/* ---------------------------------------------------------------------------------------
 * Error body — EXTENDED (additive `code` values). Unchanged `error` text semantics.
 * ------------------------------------------------------------------------------------- */

/** Machine-readable reason of a message-upload rejection (always with a human `error`). */
export type MessageUploadErrorCode =
  | 'invalid_payload' // 400 multipart structure / payload JSON problems
  | 'empty_message' // 400 no text and no files
  | 'too_many_files' // 400 more than MAX_MESSAGE_FILES file parts
  | 'unsupported_file_type' // 400 extension not in MESSAGE_FILE_EXTENSIONS (msg lists allowed)
  | 'empty_file' // 400 0-byte file
  | 'unreadable_file' // 400 e-book text extraction failed / image or PDF signature mismatch
  | 'file_too_large'; // 413 over MAX_MESSAGE_FILE_BYTES

export interface ErrorBody {
  /** Human-readable, safe to show. Upload errors name the ORIGINAL file name, e.g.
   *  `Unsupported file type "notes.docx". Allowed: .md, .txt, …`,
   *  `"big.pdf" is larger than 20 MB`, `Too many files: at most 10 per message`,
   *  `"empty.txt" is empty`, `Cannot read book.epub: …`. */
  error: string;
  code?: ConflictCode | MessageUploadErrorCode;
  /** Present only on 400 Zod validation errors (`error: 'Invalid input'`). */
  details?: unknown;
}
