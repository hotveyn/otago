/**
 * CONTRACT SPEC (planning artifact) — feature `rich-answers`.
 * HTTP endpoints touched by this feature. All paths are under the `/api` prefix.
 * Interfaces / constants only.
 */
import type { AttachmentInfo } from './attachments';

/** Error body for every non-2xx JSON response (unchanged, restated for completeness). */
export interface ApiErrorBody {
  error: string;
  /** Only for 400 schema-validation errors. */
  details?: unknown;
}

// ---------------------------------------------------------------------------
// GET /api/trees/:tree/chain?node=<nodeId>        (CHANGED — additive)
// ---------------------------------------------------------------------------

/** Same as before plus `attachments` (always present; `[]` for nodes without `attachments/`). */
export interface ChainNode {
  id: string;
  name: string;
  created: string;
  model: string;
  user: string;
  assistant: string;
  /** Files in `<node>/attachments/`, sorted by name (ASCII order). `origin` is never set here. */
  attachments: AttachmentInfo[];
}

export interface ChainResponse {
  chain: ChainNode[];
}

// ---------------------------------------------------------------------------
// GET /api/trees/:tree/attachments?node=<nodeId>&name=<name>[&download=1]   (NEW)
// ---------------------------------------------------------------------------

export const ATTACHMENT_ROUTE = '/api/trees/:tree/attachments';

/**
 * Query string. Build the URL as:
 *   `/api/trees/${encodeURIComponent(tree)}/attachments?node=${encodeURIComponent(nodeId)}&name=${encodeURIComponent(name)}`
 * Append `&download=1` for a forced download.
 */
export interface AttachmentQuery {
  /** Committed node id (not `""`). Attachments of a streaming answer are not fetchable until `done`. */
  node: string;
  /** Final attachment name as returned in `AttachmentInfo.name`. */
  name: string;
  /** `"1"` → `Content-Disposition: attachment`; otherwise `inline`. */
  download?: '1';
}

/**
 * 200 response: raw file bytes, streamed from disk. Headers:
 * - `Content-Type`: `AttachmentInfo.contentType`
 * - `Content-Length`: file size
 * - `Content-Disposition`: `inline` | `attachment`, with `filename="<name>"` (+ `filename*=UTF-8''…`)
 * - `X-Content-Type-Options: nosniff`
 * - `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`
 *   (so an SVG/HTML opened directly never runs scripts or loads external resources)
 * - `Cache-Control: no-cache`
 * HEAD is supported (Fastify auto HEAD route).
 *
 * Errors (JSON `ApiErrorBody`):
 * - 400 invalid node id or name (fails ATTACHMENT_NAME_PATTERN / contains `..`)
 * - 404 tree, node or attachment not found
 * Not blocked by the per-tree lock (read-only).
 */
export type AttachmentResponseHeaders = {
  'content-type': string;
  'content-length': string;
  'content-disposition': string;
  'x-content-type-options': 'nosniff';
  'content-security-policy': string;
  'cache-control': 'no-cache';
};

// ---------------------------------------------------------------------------
// Unchanged endpoints whose behavior shifts slightly
// ---------------------------------------------------------------------------

/**
 * POST /api/trees/:tree/nodes/move, POST /api/trees/:tree/nodes/delete, GET /api/trees/:tree:
 * - Shapes unchanged. `HierarchyNode` gets NO attachment fields.
 * - `attachments` is never a node name at any level; a moved/created node that would collide
 *   gets a `-2` suffix. Attachments move/delete with their node (they are inside its folder).
 * - Still 409 while a message is streaming in the same tree.
 */
export type NodeManagementUnchanged = never;
