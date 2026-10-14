/**
 * tree-undo — contract spec: error body and codes relevant to undo.
 *
 * PLANNING ARTIFACT. Body shape is the existing central error handler's shape (unchanged).
 */

/** Existing JSON error body. `code` / `details` are omitted when absent. */
export interface ErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

/** Existing 409 codes from `TreeLocks` (unchanged). Client: keep the history entry, toast, allow retry. */
export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';

/**
 * NEW optional 404 codes. The client treats ANY 404 on an undo request as "stale entry":
 * toast, drop the entry, keep the rest of the stack. Codes only refine the toast text.
 */
export type NotFoundCode =
  /** A node id in `ids` does not exist (move/delete). */
  | 'node_not_found'
  /** Move target parent / restore parent does not exist (e.g. deleted after the action). */
  | 'parent_not_found'
  /** A TrashId's folder does not exist (purged or restored elsewhere). */
  | 'trash_not_found'
  /** Unknown tree (existing message, now with a code). */
  | 'tree_not_found';

/**
 * Status mapping the client relies on:
 * - 400 → invalid request (programming error / malformed TrashId): toast, drop entry.
 * - 404 → stale: toast, drop entry.
 * - 409 → busy: toast, KEEP entry.
 */
export type UndoStatusPolicy = { 400: 'drop'; 404: 'drop'; 409: 'keep' };
