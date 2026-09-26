/**
 * CONTRACT SPEC (planning artifact, not runtime code) — feature `side-chat`.
 *
 * JSON error body returned by every `/api/*` route for non-2xx responses.
 *
 * STATUS: EXTENDED, backward compatible. `error` is unchanged. The optional `code`
 * field is NEW and is set only for 409 tree-lock conflicts, so the web client can tell
 * "a structural op is running" from "answers are streaming" without parsing messages.
 * Existing clients that read only `error` keep working.
 */

export type ConflictCode = 'tree_busy_streaming' | 'tree_busy_structural';

export interface ErrorBody {
  /** Human-readable message; safe to show in the UI. */
  error: string;
  /** Present only on 409 lock conflicts (see `./concurrency.ts`). */
  code?: ConflictCode;
  /** Present only on 400 schema validation errors. */
  details?: unknown;
}
