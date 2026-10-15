/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 * Error codes and status tables of the suggestion routes. Body shape UNCHANGED:
 * `{ error: string; code?: ErrorCode; details?: unknown }` (central handler in `app.ts`).
 */

/** NEW code. */
export type SuggestionErrorCode =
  /**
   * 502: generation failed, timed out, returned an unparseable reply, or the node's file
   * changed during generation so the result was discarded. node.md stays MISSING.
   * Message (exact, safe to show): 'Could not generate suggestions. They will be retried the next time the node is opened.'
   */
  'suggestions_failed';

/** Existing codes reused (unchanged). */
export type ReusedCodes = 'tree_not_found' | 'node_not_found';

/**
 * GET /api/trees/:tree/suggestions?node=
 * | 200 | —                  | SuggestionsResponse (`ready` or `missing`)                       |
 * | 400 | (none) + details   | `node` absent / longer than 1000 (Zod: `Invalid input`)          |
 * | 400 | (none)             | `node` is `""` or malformed: 'The tree root has no suggestions' / 'Invalid node id' |
 * | 404 | `tree_not_found`   | unknown tree                                                     |
 * | 404 | `node_not_found`   | no live node at that id                                          |
 *
 * POST /api/trees/:tree/suggestions   body { node }
 * | 200 | —                  | SuggestionsReady (already stored, or freshly generated)          |
 * | 400 | (none) + details   | invalid JSON body                                                |
 * | 400 | (none)             | `node` is `""` or malformed                                      |
 * | 404 | `tree_not_found`   | unknown tree (also: the tree was renamed during generation)      |
 * | 404 | `node_not_found`   | no live node at that id (also: moved/renamed/deleted during generation) |
 * | 502 | `suggestions_failed` | see above                                                      |
 * Never 409: suggestion routes take no tree lock.
 *
 * Existing routes: UNCHANGED status tables. In particular no structural route
 * (delete/move/restore/rename/title PATCH) can get a 409 because of a suggestion generation.
 */
export type StatusTables = never;
