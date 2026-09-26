/**
 * CONTRACT SPEC (planning artifact, not runtime code) — feature `side-chat`.
 *
 * `POST /api/trees/:tree/messages` — ask a question and stream the answer as SSE.
 *
 * STATUS: UNCHANGED wire format. The side chat uses this exact endpoint with
 * `parentId = <anchor node id>` (first turn) or `<latest side node id>` (later turns).
 * The only behavioural change is concurrency (see `./concurrency.ts`): several
 * message streams may now run in the same tree at the same time, including two
 * streams from the SAME `parentId`.
 */

/** Node ids are `/`-joined kebab-case folder names; `""` is the tree root. Max 1000 chars. */
export type NodeId = string;

export const MESSAGE_TEXT_MAX = 50_000;

/** Request body (JSON). Validated with Zod; `text` is trimmed, then must be 1..50_000 chars. */
export interface MessageRequest {
  parentId: NodeId;
  /**
   * User message. For the side chat this is the optional Markdown blockquote of the
   * selection (`> ...` lines) followed by a blank line and the question. Plain text;
   * no new node.md format.
   */
  text: string;
  /** Answer model; must be one of `GET /api/models` → `models`. Defaults to server config. */
  model?: string;
  /** Node naming model; same allowlist. Defaults to server config. */
  namingModel?: string;
}

/* ---------------------------------------------------------------------------------------
 * Pre-stream failures: normal JSON HTTP responses (no SSE), body = `ErrorBody` from
 * `./errors.ts`.
 *   400  invalid body (Zod: `{ error: 'Invalid input', details }`) or unknown model
 *   404  unknown tree, or `parentId` node not found (e.g. anchor deleted/moved:
 *        message `Node not found: <parentId>`)
 *   409  tree busy with a structural change (move/delete) — `code: 'tree_busy_structural'`
 *        (see `./concurrency.ts`). A running message stream NEVER causes 409 here anymore.
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * Stream: HTTP 200, `content-type: text/event-stream`. Frames are
 *   `event: <name>\ndata: <JSON>\n\n`
 * Exactly one terminal event (`done` or `error`) unless the client disconnects.
 * Client disconnect / abort → nothing is written, no node is created.
 * ------------------------------------------------------------------------------------- */

export type AttachmentKind = 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other';
export type AttachmentOrigin = 'inline' | 'url' | 'sandbox';

export interface AttachmentInfo {
  name: string;
  size: number;
  contentType: string;
  kind: AttachmentKind;
  /** Present only in streaming events. */
  origin?: AttachmentOrigin;
}

/** Lifecycle of one save. Order per key: `saving` → (`ready` | `failed`). */
export type AttachmentEvent =
  | { status: 'saving'; key: string; requestedName?: string; origin: AttachmentOrigin }
  | { status: 'ready'; key: string; attachment: AttachmentInfo }
  | { status: 'failed'; key: string; requestedName?: string; message: string };

/** `event: chunk` — data is a JSON string: the next piece of the answer text. */
export type ChunkEventData = string;

/** `event: attachment` */
export type AttachmentEventData = AttachmentEvent;

/**
 * `event: done` — the node was created.
 * `nodeId` is the NEW node's id: `<parentId>/<name>` (or `<name>` at root). `name` is the
 * naming model's kebab-case slug, made unique among siblings with `-2`, `-3`, ... suffixes.
 * Two concurrent streams from the same parent always receive DIFFERENT `nodeId`s, and
 * neither overwrites the other. Clients must use the returned id, never predict it.
 */
export interface DoneEventData {
  nodeId: NodeId;
  attachments: AttachmentInfo[];
}

/** `event: error` — the answer failed; no node was created. */
export interface ErrorEventData {
  message: string;
}

export type MessageSseEvent =
  | { event: 'chunk'; data: ChunkEventData }
  | { event: 'attachment'; data: AttachmentEventData }
  | { event: 'done'; data: DoneEventData }
  | { event: 'error'; data: ErrorEventData };
