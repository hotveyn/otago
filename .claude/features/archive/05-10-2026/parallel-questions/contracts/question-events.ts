/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * `GET /api/questions/events[?tree=<treeId>]` — one app-wide Server-Sent Events stream per tab.
 *
 * Response: 200, headers
 *   content-type: text/event-stream; charset=utf-8
 *   cache-control: no-cache, no-transform
 *   connection: keep-alive
 *   x-accel-buffering: no
 * Framing (WHATWG SSE):
 *   - First bytes: `retry: 2000\n\n` (SSE_RETRY_MS). Clients using a fetch loop may ignore it.
 *   - Every event: `id: <seq>\nevent: <name>\ndata: <JSON on one line>\n\n`.
 *     `seq` is a global, strictly increasing integer per server instance.
 *   - Keep-alive comment `: ping\n\n` every SSE_PING_INTERVAL_MS (clients may use it as a
 *     liveness watchdog: 3 missed pings ⇒ reconnect).
 *   - The stream never ends on its own (until the server shuts down or drops a slow consumer).
 *   - Unknown event names must be ignored by clients (forward compatibility, e.g. a future
 *     `tree_changed`).
 * `?tree=<id>` filters the snapshot and all events by the event's CURRENT `tree`. After a tree
 * rename a filtered subscriber must reconnect with the new id. The web uses the unfiltered
 * stream (it also needs other trees' completions for future notifications).
 * `Last-Event-ID` is ignored in v1: every (re)connection starts with a full snapshot. (The `id`
 * lines are the seam for a later ring-buffer replay.)
 */
import type { QuestionDetail, QuestionId, QuestionInfo } from './questions';
import type { AttachmentEvent, NodeId, TreeId } from './shared';

export const SSE_RETRY_MS = 2_000;
export const SSE_PING_INTERVAL_MS = 15_000;
/**
 * Slow-consumer cut-off: if a subscriber's socket buffers more than this many bytes, the server
 * destroys that connection. The client reconnects and receives a fresh snapshot (lossless).
 */
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * `event: snapshot` — ALWAYS the first event of every connection. Authoritative: replaces the
 * client's whole question state (entries missing from it are gone).
 * Taken and subscribed atomically (same tick): every later event on this connection happened
 * after the snapshot; nothing is missed or duplicated.
 */
export interface SnapshotEventData {
  /**
   * Random UUID generated once per server process. A different value than on the previous
   * connection means the server restarted and every question it held is lost (non-goal to
   * survive). Same value + a question missing from the snapshot ⇒ it finished/was removed
   * while the client was disconnected.
   */
  instance: string;
  /** Every retained question (all trees, or the filtered tree), sorted by `createdAt`. */
  questions: QuestionDetail[];
}

/**
 * `event: question` — a question was added, changed status (`naming`, `done`, `failed`), was
 * retried (new `attempt`, status `streaming`), or had `parentId`/`context`/`nodeId`/`tree`
 * remapped by a structural op. Carries the FULL `QuestionInfo` (never a patch).
 */
export interface QuestionEventData {
  question: QuestionInfo;
}

/**
 * `event: chunk` — next piece of answer text of attempt `attempt`.
 * `offset` = length (UTF-16 code units) of this attempt's answer BEFORE this chunk.
 * Client rule: drop if `attempt` is older than the local one; reset local text if newer;
 * if `offset > local.length` it is a GAP → resync (reconnect for a fresh snapshot);
 * otherwise append `text.slice(local.length - offset)` (empty ⇒ duplicate, ignore).
 */
export interface ChunkEventData {
  id: QuestionId;
  tree: TreeId;
  attempt: number;
  offset: number;
  text: string;
}

/** `event: attachment` — agent attachment progress of attempt `attempt` (unchanged payload). */
export interface AttachmentEventData {
  id: QuestionId;
  tree: TreeId;
  attempt: number;
  event: AttachmentEvent;
}

export type QuestionRemovedReason =
  /** `DELETE` of a running question. */
  | 'cancelled'
  /** `DELETE` of a failed question. */
  | 'dismissed'
  /** Retention TTL elapsed (done: DONE_TTL_MS; failed: FAILED_TTL_MS) or done-cap eviction. */
  | 'expired'
  /** Failed-cap eviction (oldest failed question of the tree beyond FAILED_CAP_PER_TREE). */
  | 'evicted'
  /** Its parent (or, for done, its node) was soft-deleted. */
  | 'deleted';

/** `event: removed` — the question is gone from the registry. Always its last event. */
export interface RemovedEventData {
  id: QuestionId;
  tree: TreeId;
  reason: QuestionRemovedReason;
  /** Present when the removed entry was `done`: the node it created (for late followers). */
  nodeId?: NodeId;
}

export type QuestionStreamEvent =
  | { event: 'snapshot'; data: SnapshotEventData }
  | { event: 'question'; data: QuestionEventData }
  | { event: 'chunk'; data: ChunkEventData }
  | { event: 'attachment'; data: AttachmentEventData }
  | { event: 'removed'; data: RemovedEventData };

/**
 * ORDERING GUARANTEES (per connection; events of different questions may interleave):
 *  1. `snapshot` first.
 *  2. A question's `question` (status `streaming`, attempt N) precedes every `chunk` /
 *     `attachment` of attempt N — for the first attempt and for every retry.
 *  3. Every `attachment` of attempt N precedes its `question` with status `naming` (attachments
 *     are sealed first) and every `chunk` of attempt N precedes it too.
 *  4. The terminal `question` (`done` | `failed`) of attempt N is preceded by all events of
 *     attempt N; no event of attempt N follows it.
 *  5. `done` is emitted after the node is fully on disk AND after the tree's shared lock was
 *     released for this question: a client reacting to `done` (refetch, undo, move) never sees
 *     a stale tree or a spurious 409 caused by this question.
 *  6. `failed` is emitted after staging is removed and the lock released.
 *  7. `removed` is the last event of a question id.
 * The 202 of start/retry and the corresponding `question` event are NOT ordered relative to
 * each other (different connections): clients upsert by id.
 */
export type OrderingGuarantees = never;
