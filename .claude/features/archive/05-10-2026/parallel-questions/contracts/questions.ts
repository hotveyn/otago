/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * Data model of an in-flight question, as returned by every question route and SSE event.
 *
 * A question = one user message being answered under an existing node. It lives ONLY in the
 * server's in-memory registry (never in `trees/`) until it is committed as a node. The registry
 * is tab-agnostic: no per-connection owner; any tab may list, follow, cancel or retry any
 * question (multi-tab seam). It is lost on server restart (non-goal), which clients detect
 * through `instance` (./question-events.ts).
 *
 * Web mirrors these types by hand in `web/src/api/types.ts` (there is no codegen in this repo).
 */
import type { AttachmentEvent, AttachmentInfo, NodeId, TreeId, UserFileInfo } from './shared';

/** Server-generated UUID v4 (`crypto.randomUUID()`). Never changes, also across retries. */
export type QuestionId = string;

/**
 * Lifecycle (see ./lifecycle.ts for the full state machine):
 *  - `streaming`: the agent is answering (attempt `attempt`).
 *  - `naming`:   the answer text is complete; attachments are sealed, the node name is being
 *                generated, then the node is committed. Cancel is still honored until the commit
 *                starts. UI: "Saving…", answer fully visible, no caret.
 *  - `done`:     the node exists on disk (`nodeId`). Retained briefly for late/reconnecting
 *                clients, then removed (`removed{expired}`).
 *  - `failed`:   the attempt failed; nothing was written to `trees/`. Retained until dismissed
 *                (DELETE), retried, or expired/evicted.
 * A cancelled question is not a status: it is removed immediately (`removed{cancelled}`).
 */
export type QuestionStatus = 'streaming' | 'naming' | 'done' | 'failed';

/** `streaming` | `naming`: holds the tree's shared lock and blocks structural ops (409). */
export type RunningQuestionStatus = Extract<QuestionStatus, 'streaming' | 'naming'>;

/**
 * Which chat the question belongs to. Pure data echoed back to every client so a background
 * aside can be reopened after a reload; the server attaches no behavior to it.
 * Validation on start: for `side`, `anchor` must be the parent itself or one of its ancestors
 * (`parentId === anchor || parentId.startsWith(anchor + '/')`, or `anchor === ""`), else 400.
 * Remapped together with `parentId` after moves/renames; if a move takes the parent out of the
 * anchor's subtree, the server sets `anchor = parentId` (invariant kept).
 */
export type QuestionContext = { kind: 'main' } | { kind: 'side'; anchor: NodeId };

/** Why an attempt failed. Every failure is retryable. */
export type QuestionFailureCode =
  /** The agent threw / the SDK reported an error / the answer was empty. */
  | 'agent_error'
  /** The attempt exceeded ATTEMPT_TIMEOUT_MS (watchdog, ./lifecycle.ts). */
  | 'timeout'
  /** Server-side failure outside the agent (sealing, committing, disk errors). */
  | 'internal';

export interface QuestionError {
  /** Human-readable, safe to show (same text today's SSE `error` event carried). */
  message: string;
  code: QuestionFailureCode;
}

interface QuestionBase {
  id: QuestionId;
  /** CURRENT tree id (updated in place after a tree rename). */
  tree: TreeId;
  /** CURRENT parent node id (remapped after moves/renames of an ancestor). */
  parentId: NodeId;
  context: QuestionContext;
  /** User text exactly as stored in `node.md` (trimmed; `""` for a files-only message). */
  text: string;
  /**
   * Server display title (pending-node label fallback, 409 blocker lists, notifications):
   * first non-empty line of `text`, whitespace collapsed, at most QUESTION_TITLE_MAX_GRAPHEMES
   * graphemes + `…` when cut (grapheme-safe). Files-only message: stored file names joined by
   * `, ` (same cut). Clients may truncate further.
   */
  title: string;
  /**
   * User files of the message, with their FINAL stored names (identical before and after the
   * commit): staged (`streaming`/`naming`), held for retry (`failed`), or committed (`done`,
   * = `listUserFiles(node)`). `[]` when none. Sorted by name.
   * Bytes are fetchable only after `done`, via `GET /api/trees/:tree/files?node=<nodeId>&name=`.
   * (Seam: a future `GET /api/questions/:id/files/:name` for thumbnails of pending files.)
   */
  files: UserFileInfo[];
  /** Answer model actually used (validated against `GET /api/models`). */
  model: string;
  namingModel: string;
  /** 1-based; incremented by every retry. Chunks/attachment events carry it. */
  attempt: number;
  /** ISO time the question was first registered (stable across retries). */
  createdAt: string;
  /** ISO time of the last status/meta change (NOT bumped by chunks or attachment events). */
  updatedAt: string;
}

export interface RunningQuestion extends QuestionBase {
  status: RunningQuestionStatus;
}

export interface DoneQuestion extends QuestionBase {
  status: 'done';
  /** The created node. Remapped after moves/renames while the entry is retained. */
  nodeId: NodeId;
  /** Committed agent attachments of the node (`listAttachments`, no `origin`). */
  attachments: AttachmentInfo[];
}

export interface FailedQuestion extends QuestionBase {
  status: 'failed';
  error: QuestionError;
}

/**
 * Full meta of a question. Every `question` SSE event and every 202 carries the COMPLETE
 * object (never a patch); clients replace their copy by `id`.
 */
export type QuestionInfo = RunningQuestion | DoneQuestion | FailedQuestion;

/**
 * Live state of the CURRENT attempt (`live.attempt === question.attempt`).
 * - `answer`: concatenation of every chunk of this attempt so far, in UTF-16 code units; the
 *   offsets of later `chunk` events continue from `answer.length`. For `naming` it is the whole
 *   streamed answer; for `failed` the partial answer of the failed attempt (display only).
 * - `attachments`: agent attachment state of this attempt, reduced: the LATEST event per
 *   `key`, ordered by the first appearance of the key. Applying these in order with the
 *   client's existing `applyAttachmentEvent` reproduces the live list exactly. Files named in
 *   `ready` events are not fetchable before `done` (staging is never served).
 */
export interface QuestionLive {
  attempt: number;
  answer: string;
  attachments: AttachmentEvent[];
}

/**
 * Question + live state: used by the SSE `snapshot`, `GET /api/questions` and
 * `GET /api/questions/:id`. `live` is `null` for `done` (the text was dropped at commit;
 * `node.md` holds it — fetch `GET /chain?node=<nodeId>`), non-null otherwise.
 */
export type QuestionDetail = QuestionInfo & { live: QuestionLive | null };

/** Display-title cut (see `QuestionBase.title`). */
export const QUESTION_TITLE_MAX_GRAPHEMES = 80;
