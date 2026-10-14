/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * HTTP routes for in-flight questions. All paths are under `/api`. JSON errors use the central
 * error body (./errors.ts).
 *
 * DECISION (open question "API shape"): start returns an id (202); ONE app-wide multiplexed SSE
 * stream (./question-events.ts) delivers snapshot + deltas of every question. No per-question
 * attach stream, no polling. Rationale: the browser talks HTTP/1.1 through the Vite proxy (6
 * connections per origin, shared by all tabs); one stream per tab is independent of the number
 * of parallel questions, and a reconnect snapshot makes reload/re-attach free.
 *
 * REMOVED (lockstep with the web): `POST /api/trees/:tree/messages` (POST-SSE). After this
 * feature it returns 404. Its body encodings and validation live on in `POST .../questions`.
 *
 * Per-question routes are tree-less (`/api/questions/:id`): ids are global UUIDs, and a tree
 * rename would otherwise make a tree segment stale. `:id` is validated as a UUID (else 400).
 */
import type { QuestionContext, QuestionDetail, QuestionId, QuestionInfo } from './questions';
import type { NodeId, TreeId } from './shared';

/* ---------------------------------------------------------------------------------------
 * POST /api/trees/:tree/questions — start a question                         (NEW)
 *
 * Body encodings: IDENTICAL to the old `/messages` (chat-file-attachments contract):
 *  A) `application/json` → `StartQuestionRequest` (no files; `text` required, 1..50 000 after trim).
 *  B) `multipart/form-data` → first part `payload` (JSON string of `StartQuestionPayload`), then
 *     1..10 file parts named `files` (each ≤ 20 MiB, allow-list unchanged). Part rules and
 *     upload error codes unchanged.
 *
 * Server sequence (authoritative):
 *  1. Decode/validate the body (400), models (400 unknown model), `context` (400).
 *  2. Tree exists (404 `tree_not_found`).
 *  3. Generate the question id; take the tree's SHARED lock with the id as holder
 *     (409 `tree_busy_structural` if a structural op runs).
 *  4. Read the chain; parent must exist (404 `parent_not_found`, message `Parent node not
 *     found: <id>`). Create the answer staging folder under the parent.
 *  5. Receive and fully validate/stage the uploaded files (400/413 upload codes;
 *     400 `empty_message` when no text and no files).
 *     A client disconnect during steps 1-5 aborts: staging removed, lock released, NO registry
 *     entry, nothing written. Any rejection here likewise never creates an entry.
 *  6. Register the question (status `streaming`, attempt 1) and emit the `question` SSE event.
 *  7. Respond 202. From now on the client connection is irrelevant: disconnecting does NOT
 *     abort generation; only `DELETE /api/questions/:id` (or the watchdog) does.
 * The 202 and the SSE `question` event may arrive in either order: clients upsert by `id`.
 *
 * Follow-ups under a pending node: NOT supported (open question → default "no"). `parentId`
 * must be an existing node; a pending question has no node id until `done`.
 * ------------------------------------------------------------------------------------- */

export const MESSAGE_PAYLOAD_FIELD = 'payload';
export const MESSAGE_FILES_FIELD = 'files';
export const MESSAGE_TEXT_MAX = 50_000;

/** JSON body (encoding A). Old `MessageRequest` + optional `context`. Unknown keys stripped. */
export interface StartQuestionRequest {
  parentId: NodeId;
  /** Trimmed, 1..50 000 chars. */
  text: string;
  /** Answer model; must be in `GET /api/models`. Default: server config. */
  model?: string;
  /** Naming model; same allowlist. Default: server config. */
  namingModel?: string;
  /** Default `{ kind: 'main' }`. */
  context?: QuestionContext;
}

/** `payload` field (encoding B). Same as JSON, but `text` may be empty when files are attached. */
export interface StartQuestionPayload extends Omit<StartQuestionRequest, 'text'> {
  /** Trimmed, 0..50 000 chars, default `""`. Empty text AND no files → 400 `empty_message`. */
  text?: string;
}

/** 202 Accepted. Header `location: /api/questions/<id>`. */
export interface StartQuestionResponse {
  /** `status: 'streaming'`, `attempt: 1`, `files` = staged files with final names. */
  question: QuestionInfo;
}

/* ---------------------------------------------------------------------------------------
 * GET /api/questions[?tree=<treeId>] — JSON snapshot                           (NEW)
 * Same data as the SSE `snapshot` event. For tests, tools and non-streaming clients.
 * Unknown tree in the filter → `questions: []` (no 404). Sorted by `createdAt`.
 * ------------------------------------------------------------------------------------- */

export interface ListQuestionsQuery {
  tree?: TreeId;
}

export interface ListQuestionsResponse {
  /** Server instance id (see ./question-events.ts `SnapshotEventData.instance`). */
  instance: string;
  questions: QuestionDetail[];
}

/* ---------------------------------------------------------------------------------------
 * GET /api/questions/:id — one question with live state                        (NEW)
 * 404 `question_not_found` for unknown/removed ids. Intended for resync; the web v1 resyncs by
 * reconnecting the stream instead.
 * ------------------------------------------------------------------------------------- */

export interface GetQuestionResponse {
  question: QuestionDetail;
}

/* ---------------------------------------------------------------------------------------
 * DELETE /api/questions/:id — cancel a running question / dismiss a failed one  (NEW)
 *
 * One verb, one rule: "remove this question; never touches a created node".
 *  - `streaming` / `naming` before the commit started → CANCEL: abort the agent (and naming),
 *    discard staging (files and attachments), release the shared lock, emit
 *    `removed{reason:'cancelled'}`, THEN respond 204. Because the response waits for the
 *    teardown, a structural op retried right after the 204 does not get a spurious 409.
 *  - `failed` → DISMISS: delete held files, emit `removed{reason:'dismissed'}`, 204.
 *    (A cancel that races with a failure therefore just removes the failed entry.)
 *  - commit already started → wait for the commit outcome (milliseconds), then apply the
 *    rule for the resulting status.
 *  - `done` → 409 `question_finished`, `details: { nodeId }` (the node exists; done entries
 *    expire by themselves; they are never deleted by clients — multi-tab safe).
 *  - failed entry whose retry is being prepared → the preparation is aborted, then dismissed.
 *  - unknown id → 404 `question_not_found` (clients treat it as already removed).
 * ------------------------------------------------------------------------------------- */

export type DeleteQuestionResponse = void; // 204 No Content

/* ---------------------------------------------------------------------------------------
 * POST /api/questions/:id/retry — re-run a failed question                       (NEW)
 *
 * No body (any body is ignored). Same id, same text, same held files, same models and
 * context, the CURRENT `parentId`/`tree` (they may have been remapped since the failure).
 * Sequence: status must be `failed` and no retry in progress (else 409 `question_not_failed`)
 * → shared lock (409 `tree_busy_structural`) → tree (404 `tree_not_found`) and parent chain
 * (404 `parent_not_found`) → new staging, held files moved back in → `attempt + 1`, status
 * `streaming`, live state reset (`answer: ''`, `attachments: []`), `question` event emitted →
 * 202. On any pre-202 failure the entry stays `failed` unchanged (its held files are kept).
 * The retried attempt's `question` event precedes all of its chunks on the stream.
 * (Seam: an optional `{ model?, namingModel? }` body could switch models later.)
 * ------------------------------------------------------------------------------------- */

export interface RetryQuestionResponse {
  /** `status: 'streaming'`, `attempt` = previous + 1. */
  question: QuestionInfo;
}

/* ---------------------------------------------------------------------------------------
 * GET /api/questions/events[?tree=<treeId>] — the event stream                  (NEW)
 * See ./question-events.ts.
 * ------------------------------------------------------------------------------------- */

/** Endpoint table (documentation aid). */
export interface QuestionRoutes {
  'POST /api/trees/:tree/questions': {
    body: StartQuestionRequest | FormData;
    response: StartQuestionResponse;
    status: 202;
  };
  'GET /api/questions': { query: ListQuestionsQuery; response: ListQuestionsResponse };
  'GET /api/questions/:id': { params: { id: QuestionId }; response: GetQuestionResponse };
  'DELETE /api/questions/:id': { params: { id: QuestionId }; response: DeleteQuestionResponse };
  'POST /api/questions/:id/retry': {
    params: { id: QuestionId };
    response: RetryQuestionResponse;
    status: 202;
  };
  'GET /api/questions/events': { query: ListQuestionsQuery; response: 'text/event-stream' };
}

/**
 * Other routes touched by this feature (shapes unchanged):
 *  - `POST /api/trees/:tree/nodes/{delete,move,restore,rename}` and a title
 *    `PATCH /api/trees/:tree`: the 409 `tree_busy_streaming` body gains
 *    `details: TreeBusyDetails` (./errors.ts). On success they also update retained (failed /
 *    done) questions: move/rename remap `parentId`, `context.anchor` and `nodeId` by prefix and
 *    emit `question` events; delete removes questions whose parent (or, for done, node) lies in
 *    a deleted subtree (`removed{reason:'deleted'}`); a tree rename rewrites `tree` and emits
 *    `question` events. Restore changes no live ids (nothing to remap; questions removed by a
 *    delete do NOT come back on undo).
 *  - Every route that accepts node ids (`?node=`, `parentId`, `ids`, `targetParentId`,
 *    `names` keys and values, `trashIds`, rename `id`) normalizes them to NFC first.
 *  - `POST /nodes/rename` and `createNode` use `toNodeName` (Unicode, ./node-names.ts);
 *    move `names` values are validated with `isNodeName`.
 */
export type TouchedRoutes = never;
