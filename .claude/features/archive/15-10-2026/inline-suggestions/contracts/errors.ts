/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * Error codes and status tables. Body shape UNCHANGED:
 * `{ error: string; code?: ErrorCode; details?: unknown }` (central handler in `app.ts`).
 */

/**
 * REMOVED: `SuggestionErrorCode = 'suggestions_failed'` (502) and the server's
 * `SuggestionsFailedError`. No route can fail because of suggestions any more. Clients remove
 * the code from their known-code lists (`web/src/api/client.ts`, `web/src/api/types.ts`).
 */
export type RemovedCodes = 'suggestions_failed';

/** Existing codes reused (unchanged). */
export type ReusedCodes = 'tree_not_found' | 'node_not_found';

/**
 * GET /api/trees/:tree/suggestions?node=   (UNCHANGED table except: 200 is always `ready`)
 * | 200 | —                  | SuggestionsReady                                                 |
 * | 400 | (none) + details   | `node` absent / longer than 1000 (Zod: `Invalid input`)          |
 * | 400 | (none)             | `node` is `""` or malformed: 'The tree root has no suggestions' / 'Invalid node id' |
 * | 404 | `tree_not_found`   | unknown tree                                                     |
 * | 404 | `node_not_found`   | no live node at that id                                          |
 * Never 409: takes no tree lock (also not while questions stream).
 *
 * POST /api/trees/:tree/suggestions → 404 (no such route; Fastify default reply, no `code`).
 *
 * Questions (`POST /trees/:tree/questions`, retry, cancel): status tables UNCHANGED. A block the
 * server cannot use never fails a question (E1). New failure path inside an attempt (not a new
 * code): an answer that is empty once the block is removed → failed with `agent_error`,
 * message 'Agent returned an empty answer' (same as an empty answer today).
 * E12: suggestions never take a lock and never cause a 409; they are written by `createNode`.
 */
export type StatusTables = never;
