/**
 * CONTRACT SPEC (planning artifact) — feature `chat-file-attachments`.
 * `POST /api/trees/:tree/messages` — ask a question (optionally with files) and stream the answer.
 *
 * DECISION (open question "transport"): ONE request, two accepted body encodings.
 * Upload-first/staging-ids was rejected (needs TTL staging + GC, orphan uploads, two-phase abort;
 * breaks "no DB, bounded, atomic"). Base64-in-JSON rejected (buffers everything, +33 %).
 *
 * A) `content-type: application/json` — UNCHANGED, byte-for-byte compatible. Used when there are
 *    no files. Body = `MessageRequest` with `text` trimmed, 1..50_000 chars (still required).
 *
 * B) `content-type: multipart/form-data; boundary=…` — used when there is at least one file.
 *    Parts, IN THIS ORDER:
 *      1. exactly one text field named `payload` (MESSAGE_PAYLOAD_FIELD), FIRST, whose value is a
 *         JSON string of `MessagePayload`. Browser: `form.append('payload', JSON.stringify(p))`.
 *         (A part with `content-type: application/json` is accepted too.)
 *      2. 1..MAX_MESSAGE_FILES file parts, each named `files` (MESSAGE_FILES_FIELD):
 *         `form.append('files', file, file.name)`. The filename may be empty/generic for
 *         clipboard images; the part MIME type is then used (see IMAGE_MIME_EXTENSIONS).
 *    Anything else (payload missing / not first / duplicated, other field names, non-file part
 *    after payload, a file part not named `files`) → 400 `invalid_payload`.
 *    The client must NOT set `content-type` manually (let the browser add the boundary).
 *    Zero file parts in a multipart request is allowed (behaves like JSON; text rule below).
 *
 * Response (both encodings): identical to today. Pre-stream failures are JSON errors (no SSE);
 * success is HTTP 200 `text/event-stream`.
 *
 * Server guarantees (authoritative; never trusts client name/type/size):
 *  - The whole upload is received, streamed to disk (bounded memory: at most one e-book buffered
 *    at a time for text extraction) and FULLY validated BEFORE the 200/SSE headers are sent and
 *    BEFORE the agent starts: count, allowed extension, non-empty, ≤ MAX_MESSAGE_FILE_BYTES,
 *    image/PDF magic bytes, e-book text extraction.
 *    => For the web: "response headers not received yet" = uploading/checking; `res.ok` = answering.
 *  - Files are written into the answer staging folder (`<parent>/.tmp-answer-XXXX/files/`) and
 *    appear together with `node.md` via the same atomic rename. Any failure, abort (client
 *    disconnect during upload or stream), or agent error → the staging folder (with the files)
 *    is deleted; no node and no files remain.
 *  - The shared tree lock is taken before files are written (upload counts as part of the
 *    stream): move/delete during an upload → 409 `tree_busy_streaming` for them.
 *  - Request size is bounded by limits: ≤ 1 field (payload, ≤ MESSAGE_PAYLOAD_MAX_BYTES),
 *    ≤ MAX_MESSAGE_FILES files, each ≤ MAX_MESSAGE_FILE_BYTES. These limits apply to this route
 *    only; `POST /trees/:tree/sources` keeps `files: 1`.
 */
import type { AttachmentEvent, AttachmentInfo, NodeId } from './shared';
import type { UserFileInfo } from './user-files';

export const MESSAGE_PAYLOAD_FIELD = 'payload';
export const MESSAGE_FILES_FIELD = 'files';
export const MESSAGE_TEXT_MAX = 50_000;
/** Max bytes of the `payload` field value (50 000 chars × up to 4 bytes UTF-8, plus JSON). */
export const MESSAGE_PAYLOAD_MAX_BYTES = 256 * 1024;

/** JSON body (encoding A). UNCHANGED. `text`: trimmed, 1..50_000 chars. */
export interface MessageRequest {
  parentId: NodeId;
  text: string;
  /** Answer model; must be in `GET /api/models`. Defaults to server config. */
  model?: string;
  /** Node naming model; same allowlist. Defaults to server config. */
  namingModel?: string;
}

/**
 * `payload` field value (encoding B). Same fields as `MessageRequest`, except `text` may be
 * empty/whitespace-only (it is trimmed; default `""`) when at least one file is attached.
 *
 * DECISION (open question "empty text"): ALLOWED when files.length ≥ 1.
 *  - `node.md` stores the user text as sent (trimmed; may be `""`). No synthetic text is persisted.
 *  - The agent receives EMPTY_TEXT_QUESTION as the question.
 *  - The naming model receives `Attached files: <name1>, <name2>, …` as the question.
 *  - Empty text AND zero files → 400 `empty_message`.
 *  Web mirrors this as `canSend = text.trim() !== '' || files.length > 0`.
 *
 * EXTENSION SEAM (future, NOT implemented now): `urls?: string[]` — links the server downloads
 * into the node through the same allow-list / size cap / naming / staging path. URLs + files will
 * share MAX_MESSAGE_FILES. Until then unknown payload keys are ignored (stripped), so a newer
 * client never breaks an older server's validation.
 */
export interface MessagePayload {
  parentId: NodeId;
  text?: string;
  model?: string;
  namingModel?: string;
  // urls?: string[];  // reserved, see above
}

export const EMPTY_MESSAGE_ALLOWED_WITH_FILES = true;
/** Question given to the agent when the user sent files without text. */
export const EMPTY_TEXT_QUESTION =
  'The user sent the attached files without a message. Look at them and respond helpfully.';

/* ---------------------------------------------------------------------------------------
 * Pre-stream failures (JSON `ErrorBody`, see ./http.ts). All happen before any SSE byte and
 * leave nothing on disk:
 *   400  invalid JSON body / payload (Zod: `{ error: 'Invalid input', details }`), unknown model,
 *        `invalid_payload`, `empty_message`, `too_many_files`, `unsupported_file_type`,
 *        `empty_file`, `unreadable_file` (bad e-book / image / PDF signature)
 *   404  unknown tree / parent node
 *   409  tree busy with a structural change (`tree_busy_structural`)
 *   413  `file_too_large`
 *   415  neither JSON nor multipart (Fastify default)
 * Validation order: payload → model → tree/parent (404) → lock (409) → files in arrival order
 * (the first bad file decides the error; its original name is in the message).
 * ------------------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------------------
 * Stream: HTTP 200, `text/event-stream`, frames `event: <name>\ndata: <JSON>\n\n`. UNCHANGED
 * except `done` (additive). Unknown events must be ignored by clients.
 * ------------------------------------------------------------------------------------- */

/** `event: chunk` — next piece of answer text (unchanged). */
export type ChunkEventData = string;

/** `event: attachment` — agent attachment progress (unchanged; never about user files). */
export type AttachmentEventData = AttachmentEvent;

/**
 * `event: done` — the node was created. CHANGED (additive): `files`.
 * `files` = the new node's user files exactly as `GET /chain` returns them for this node
 * (`[]` when none). Needed because the web seeds the chain cache from `done` and does not refetch.
 * Files are fetchable via `GET /trees/:tree/files` only after `done`.
 */
export interface DoneEventData {
  nodeId: NodeId;
  attachments: AttachmentInfo[];
  files: UserFileInfo[];
}

/** `event: error` — the answer failed; no node and no user files were written (unchanged). */
export interface ErrorEventData {
  message: string;
}

export type MessageSseEvent =
  | { event: 'chunk'; data: ChunkEventData }
  | { event: 'attachment'; data: AttachmentEventData }
  | { event: 'done'; data: DoneEventData }
  | { event: 'error'; data: ErrorEventData };
