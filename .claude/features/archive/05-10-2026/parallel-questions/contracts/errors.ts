/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * Error body and codes. Body shape = the existing central error handler (`server/src/app.ts`),
 * unchanged; `code` / `details` are omitted when absent.
 */
import type { QuestionContext, QuestionId, QuestionStatus } from './questions';
import type { NodeId, TreeId } from './shared';

export interface ErrorBody {
  /** Human-readable, safe to show. */
  error: string;
  code?: ErrorCode;
  /**
   * CHANGED: no longer "400 only". Present on:
   *  - 400 `Invalid input` (Zod issues, unchanged),
   *  - 409 `tree_busy_streaming` → `TreeBusyDetails`,
   *  - 409 `question_finished` → `QuestionFinishedDetails`.
   */
  details?: unknown;
}

/** Existing codes (unchanged). */
export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';
export type NotFoundCode =
  | 'node_not_found'
  | 'parent_not_found'
  | 'trash_not_found'
  | 'tree_not_found';
export type MessageUploadErrorCode =
  | 'invalid_payload'
  | 'empty_message'
  | 'too_many_files'
  | 'unsupported_file_type'
  | 'empty_file'
  | 'unreadable_file'
  | 'file_too_large';

/** NEW codes of the question routes. */
export type QuestionErrorCode =
  /** 404: unknown id, or already removed (cancelled/dismissed/expired/evicted/deleted). */
  | 'question_not_found'
  /** 409 on DELETE: the question produced a node (done, or the commit won the race). */
  | 'question_finished'
  /** 409 on retry: the question is running, done, or already being retried. */
  | 'question_not_failed';

export type ErrorCode = ConflictCode | NotFoundCode | MessageUploadErrorCode | QuestionErrorCode;

/** One question that holds the tree's shared lock. */
export interface BlockingQuestion {
  id: QuestionId;
  tree: TreeId;
  parentId: NodeId;
  context: QuestionContext;
  /** Same as `QuestionInfo.title`. */
  title: string;
  status: Extract<QuestionStatus, 'streaming' | 'naming'>;
}

/**
 * `details` of EVERY 409 `tree_busy_streaming`, whichever route raised it: `nodes/delete`,
 * `nodes/move`, `nodes/restore` (undo), `nodes/rename`, a title `PATCH /trees/:tree`, and any
 * future exclusive route. Filled centrally by the error handler from the lock's holder ids.
 * The message text is unchanged:
 *   'Tree "<tree>" is busy: an answer is still streaming. Try again when it finishes.'
 * Clients may merge `questions` with their own store; the server list wins when they differ.
 */
export interface TreeBusyDetails {
  /** Running questions of the tree (sorted by `createdAt`). */
  questions: BlockingQuestion[];
  /**
   * Shared-lock holders with no running question: uploads still being received/validated by a
   * start request, or retries being prepared. They finish (or fail) within the request.
   */
  preparing: number;
}

/** `details` of 409 `question_finished`. */
export interface QuestionFinishedDetails {
  nodeId: NodeId;
}

/**
 * Status / code tables.
 *
 * POST /api/trees/:tree/questions
 * | 202 | —                      | registered (StartQuestionResponse)                        |
 * | 400 | (none) + details       | Zod-invalid JSON body / payload (`Invalid input`)         |
 * | 400 | (none)                 | unknown model; side `context.anchor` not an ancestor-or-self of `parentId`; malformed node id |
 * | 400 | upload codes           | `invalid_payload`, `empty_message`, `too_many_files`, `unsupported_file_type`, `empty_file`, `unreadable_file` |
 * | 404 | `tree_not_found`       | unknown tree (incl. an old id after a tree rename)        |
 * | 404 | `parent_not_found`     | parent node does not exist                                |
 * | 409 | `tree_busy_structural` | a move/delete/restore/rename holds the tree               |
 * | 413 | `file_too_large`       | a file over 20 MiB                                        |
 * | 415 | (Fastify default)      | neither JSON nor multipart                                |
 * Validation order: body/payload → models → context → tree → lock → parent → files (in
 * arrival order; the first bad file decides). Nothing is registered or written on any error.
 *
 * GET /api/questions/:id          | 200 | 400 (id not a UUID) | 404 `question_not_found`
 * DELETE /api/questions/:id       | 204 | 400 | 404 `question_not_found` | 409 `question_finished` + QuestionFinishedDetails
 * POST /api/questions/:id/retry   | 202 | 400 | 404 `question_not_found` | 409 `question_not_failed`
 *                                 | 409 `tree_busy_structural` | 404 `tree_not_found` | 404 `parent_not_found`
 *                                 | 500 (held files could not be restored; entry stays failed)
 * GET /api/questions, GET /api/questions/events | 200 only.
 *
 * Exclusive routes (delete/move/restore/rename/title PATCH): unchanged except that
 * 409 `tree_busy_streaming` now always carries `details: TreeBusyDetails`.
 */
export type StatusTables = never;
