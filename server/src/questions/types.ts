// Runtime mirror of .claude/features/parallel-questions/contracts/{questions,question-events,
// errors,lifecycle}.ts. The web mirrors the same contract by hand.
import type { AttachmentEvent, AttachmentInfo, UserFileInfo } from '../storage/index.js';

/** Server-generated UUID v4. Never changes, also across retries. */
export type QuestionId = string;

export type QuestionStatus = 'streaming' | 'naming' | 'done' | 'failed';
/** Holds the tree's shared lock and blocks structural ops (409). */
export type RunningQuestionStatus = Extract<QuestionStatus, 'streaming' | 'naming'>;

/** Which chat the question belongs to; pure data echoed back to every client. */
export type QuestionContext = { kind: 'main' } | { kind: 'side'; anchor: string };

export type QuestionFailureCode = 'agent_error' | 'timeout' | 'internal';

export interface QuestionError {
  message: string;
  code: QuestionFailureCode;
}

export interface QuestionBase {
  id: QuestionId;
  /** Current tree id (rewritten after a tree rename). */
  tree: string;
  /** Current parent node id (remapped after moves/renames). */
  parentId: string;
  context: QuestionContext;
  /** User text as stored in `node.md` (`""` for a files-only message). */
  text: string;
  /** Display title: first line, ≤ 80 graphemes + `…`; file names for a files-only message. */
  title: string;
  /** User files with their final stored names, sorted by name (`[]` when none). */
  files: UserFileInfo[];
  model: string;
  namingModel: string;
  /** 1-based; incremented by every retry. */
  attempt: number;
  createdAt: string;
  /** Last status/meta change (not bumped by chunks or attachment events). */
  updatedAt: string;
}

export interface RunningQuestion extends QuestionBase {
  status: RunningQuestionStatus;
}

export interface DoneQuestion extends QuestionBase {
  status: 'done';
  nodeId: string;
  /** Committed agent attachments of the node (no `origin`). */
  attachments: AttachmentInfo[];
}

export interface FailedQuestion extends QuestionBase {
  status: 'failed';
  error: QuestionError;
}

export type QuestionInfo = RunningQuestion | DoneQuestion | FailedQuestion;

/** Live state of the current attempt. */
export interface QuestionLive {
  attempt: number;
  /** Every chunk of this attempt so far (UTF-16 code units; chunk offsets continue from here). */
  answer: string;
  /** Latest attachment event per `key`, in order of the key's first appearance. */
  attachments: AttachmentEvent[];
}

/** `live` is `null` for `done` (the text lives in `node.md`), non-null otherwise. */
export type QuestionDetail = QuestionInfo & { live: QuestionLive | null };

/** Display-title cut. */
export const QUESTION_TITLE_MAX_GRAPHEMES = 80;

/* --- Events (GET /api/questions/events) ------------------------------------------------ */

export interface SnapshotEventData {
  /** Random id per server process; a new value means every question was lost. */
  instance: string;
  questions: QuestionDetail[];
}

export interface QuestionEventData {
  question: QuestionInfo;
}

export interface ChunkEventData {
  id: QuestionId;
  tree: string;
  attempt: number;
  /** Length of this attempt's answer before this chunk. */
  offset: number;
  text: string;
}

export interface AttachmentEventData {
  id: QuestionId;
  tree: string;
  attempt: number;
  event: AttachmentEvent;
}

export type QuestionRemovedReason = 'cancelled' | 'dismissed' | 'expired' | 'evicted' | 'deleted';

export interface RemovedEventData {
  id: QuestionId;
  tree: string;
  reason: QuestionRemovedReason;
  /** Present when the removed entry was `done`. */
  nodeId?: string;
}

export type QuestionStreamEvent =
  | { event: 'snapshot'; data: SnapshotEventData }
  | { event: 'question'; data: QuestionEventData }
  | { event: 'chunk'; data: ChunkEventData }
  | { event: 'attachment'; data: AttachmentEventData }
  | { event: 'removed'; data: RemovedEventData };

/** Delta events emitted by the registry (everything but the per-connection `snapshot`). */
export type QuestionDeltaEvent = Exclude<QuestionStreamEvent, { event: 'snapshot' }>;

/** A delta event with its global, strictly increasing sequence number (SSE `id:`). */
export type RegistryEvent = QuestionDeltaEvent & { seq: number };

/* --- Errors ------------------------------------------------------------------------------ */

/** One question that holds the tree's shared lock. */
export interface BlockingQuestion {
  id: QuestionId;
  tree: string;
  parentId: string;
  context: QuestionContext;
  title: string;
  status: RunningQuestionStatus;
}

/** `details` of every 409 `tree_busy_streaming`. */
export interface TreeBusyDetails {
  /** Running questions of the tree, sorted by `createdAt`. */
  questions: BlockingQuestion[];
  /** Shared-lock holders without a running question (uploads, retries being prepared). */
  preparing: number;
}

/** `details` of 409 `question_finished`. */
export interface QuestionFinishedDetails {
  nodeId: string;
}

/* --- Timings ----------------------------------------------------------------------------- */

/** All timings of the question service; tests shrink them. */
export interface QuestionTimings {
  /** Watchdog: max wall time of one attempt until its commit starts. */
  attemptTimeoutMs: number;
  /** Naming call timeout (then the fallback name). */
  namingTimeoutMs: number;
  doneTtlMs: number;
  doneCapPerTree: number;
  failedTtlMs: number;
  failedCapPerTree: number;
  /** SSE keep-alive comment interval. */
  pingIntervalMs: number;
  /** SSE `retry:` sent first on every connection. */
  retryMs: number;
  /** Slow-consumer cut-off of one SSE connection. */
  maxBufferedBytes: number;
}

export const DEFAULT_QUESTION_TIMINGS: Readonly<QuestionTimings> = {
  attemptTimeoutMs: 30 * 60 * 1000,
  namingTimeoutMs: 30 * 1000,
  doneTtlMs: 30 * 60 * 1000,
  doneCapPerTree: 50,
  failedTtlMs: 24 * 60 * 60 * 1000,
  failedCapPerTree: 50,
  pingIntervalMs: 15_000,
  retryMs: 2_000,
  maxBufferedBytes: 1024 * 1024,
};

/** Minimal logger (Fastify's `app.log` fits). */
export interface QuestionLogger {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export const silentLogger: QuestionLogger = { error: () => undefined, warn: () => undefined };

/** Test seams. */
export interface QuestionHooks {
  /** Awaited right after the commit started (`committing = true`), before `createNode`. */
  beforeCommit?: (id: QuestionId) => void | Promise<void>;
}
