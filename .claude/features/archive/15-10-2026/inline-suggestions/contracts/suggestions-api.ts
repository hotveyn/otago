/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * HTTP API of suggestions + the rules clients (web, demo mock) follow. All routes under `/api`.
 * Errors use the existing body `{ error, code?, details? }` (./errors.ts).
 */
import type { NodeId } from './shared';
import type { Suggestion } from './suggestions';

// ---------------------------------------------------------------------------
// GET /api/trees/:tree/suggestions?node=<NodeId>      (pure read) — CHANGED semantics
// ---------------------------------------------------------------------------

export interface GetSuggestionsQuery {
  /** Saved node to show suggestions for. NFC-normalized by the route schema. Not `""`. */
  node: NodeId;
}

/**
 * The only response shape (decision for feature open question 3). `state` is kept as the
 * constant `'ready'` so the wire shape of existing clients' `SuggestionsReady` stays valid; the
 * `missing` variant is REMOVED.
 */
export interface SuggestionsReady {
  /** Echo of the requested node id (NFC). */
  node: NodeId;
  state: 'ready';
  /**
   * `resolveSuggestions` (./suggestions.ts): the node's own stored list, or — when it has none —
   * its nearest stored ancestor's list (E1); owner-validated, "used" removed, NOT capped.
   * `[]` = nothing to show.
   */
  suggestions: Suggestion[];
}

/** REMOVED: `SuggestionsMissing`. */
export type SuggestionsResponse = SuggestionsReady;

// ---------------------------------------------------------------------------
// POST /api/trees/:tree/suggestions — REMOVED (E10)
// ---------------------------------------------------------------------------

/**
 * The route no longer exists: Fastify's default not-found reply (404). Clients must not call it.
 * `GenerateSuggestionsBody` / `GenerateSuggestionsResponse` are removed. There is no other way
 * to generate suggestions for an existing node (non-goal: "suggest more").
 */
export type RemovedGenerateRoute = never;

/** Endpoint table (documentation aid). */
export interface SuggestionRoutes {
  'GET /api/trees/:tree/suggestions': {
    query: GetSuggestionsQuery;
    response: SuggestionsResponse;
  };
}

/**
 * CLIENT RULES (web; the demo mock reproduces the server side).
 *
 * Fetching — CHANGED
 *  - Each chat panel shows the suggestions of ITS OWN focused saved node via GET (query key
 *    `['suggestions', tree, node]`, unchanged). No POST, no "generate once" bookkeeping, no
 *    `missing` branch: the response is final. `getSuggestions(tree, node)` stays the client
 *    method name; `generateSuggestions` is removed from `web/src/api/client.ts` AND from the demo
 *    shim (`exportsComplete`).
 *  - Invalidation: unchanged (`['suggestions', tree]` after a question of the tree reached
 *    `done` or was removed, after move/delete/restore/rename/undo and title changes). A freshly
 *    saved node already has its list in node.md at `done` time (no "moments later" window).
 *
 * Visibility — CHANGED only by the cap
 *  - Show ALL items of the response (no client cap; `MAX_SUGGESTIONS` removed in the web too).
 *  - In-flight hiding rule unchanged (store entry with the same target and `suggestionKey`).
 *  - Side-panel rule unchanged (items targeting above the anchor are dropped).
 *  - A node shown through the ancestor fallback has only inherited items (`up > 0`); render them
 *    exactly like inherited items today.
 *
 * Streaming — NEW guarantee, nothing to do client-side
 *  - `chunk` events and `live.answer` never contain the block (./shared.ts). Clients must NOT try
 *    to parse or hide a block themselves.
 *
 * Clicking — UNCHANGED (`askSuggestion`, guarded `store.ask` to `target`, draft untouched).
 */
export type ClientRules = never;
