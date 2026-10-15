/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 * HTTP API of suggestions + the rules clients (web, demo mock) follow. All routes under `/api`.
 * Errors use the existing body `{ error, code?, details? }` (./errors.ts).
 *
 * DECISION (feature open question 3): a SEPARATE resource, not a field of the chain payload.
 *  - The chain is cached/seeded by the web (`seedDoneChain`) and must not grow children scans.
 *  - "Missing vs empty" is explicit in `state`.
 *  - Lazy generation is a POST (never a side effect of a GET).
 */
import type { NodeId } from './shared';
import type { Suggestion } from './suggestions';

// ---------------------------------------------------------------------------
// GET /api/trees/:tree/suggestions?node=<NodeId>      (pure read, never generates)
// ---------------------------------------------------------------------------

export interface GetSuggestionsQuery {
  /** Saved node to show suggestions for. NFC-normalized by the route schema. Not `""`. */
  node: NodeId;
}

export interface SuggestionsReady {
  /** Echo of the requested node id (NFC). */
  node: NodeId;
  state: 'ready';
  /**
   * Resolved (./suggestions.ts `resolveSuggestions`): own first, then inherited; invalid
   * inherited items and "used" items (a live child of the target already asks the same text)
   * are already removed. `[]` = nothing to show (generated empty, or everything used).
   */
  suggestions: Suggestion[];
}

export interface SuggestionsMissing {
  node: NodeId;
  /** node.md has no stored list (old node, or the generation at save failed / still runs). */
  state: 'missing';
  suggestions: [];
}

export type SuggestionsResponse = SuggestionsReady | SuggestionsMissing;

// ---------------------------------------------------------------------------
// POST /api/trees/:tree/suggestions      body: { node }   (lazy generation, idempotent)
// ---------------------------------------------------------------------------

export interface GenerateSuggestionsBody {
  node: NodeId;
}

/**
 * Semantics:
 *  1. Validate body (400), tree (404 `tree_not_found`), node exists (404 `node_not_found`).
 *  2. node.md already has a stored list → 200 `SuggestionsReady` at once (no model call).
 *  3. Otherwise join the in-flight generation for this (tree, node) or start one — at most
 *     ONE generation per node at a time across tabs/requests (in-memory dedup; this includes a
 *     generation started at save time that outlived its question's commit).
 *  4. Await it (bounded by SUGGEST_TIMEOUT_MS, ./generation.ts), then re-read and resolve
 *     → 200 `SuggestionsReady` (the list may be empty).
 *  - The model call is NOT cancelled when the client disconnects: the result is still
 *    persisted, so a reload/other tab finds it stored.
 *  - Takes NO tree lock: never 409, never blocks move/delete/restore/rename/title changes.
 *    If the node was moved/renamed/deleted (or its tree renamed) during the generation, the
 *    result is discarded (nothing is written, no folder is recreated) and the response is
 *    404 `node_not_found` (the id no longer resolves) — the client re-asks under the new id
 *    on its next open.
 *  - Generation failed / timed out / unparseable reply / the node file changed meanwhile →
 *    502 `suggestions_failed`; node.md stays MISSING (retry on the next open).
 * No model param: the server uses its configured suggestion model (./generation.ts).
 */
export type GenerateSuggestionsResponse = SuggestionsReady;

/** Endpoint table (documentation aid). */
export interface SuggestionRoutes {
  'GET /api/trees/:tree/suggestions': {
    query: GetSuggestionsQuery;
    response: SuggestionsResponse;
  };
  'POST /api/trees/:tree/suggestions': {
    body: GenerateSuggestionsBody;
    response: GenerateSuggestionsResponse;
  };
}

/**
 * CLIENT RULES (web; the demo mock reproduces the server side of them).
 *
 * Fetching
 *  - Each chat panel (main and side) shows the suggestions of ITS OWN focused saved node
 *    (never for `""`, never for a pending question box). Query key suggestion:
 *    `['suggestions', tree, node]`. Recommended client methods (the demo shim must export the
 *    same names as `web/src/api/client.ts`): `getSuggestions(tree, node)` and
 *    `generateSuggestions(tree, node)`.
 *  - `state: 'missing'` → POST once for that (tree, node) per focus/mount; on 200 put the
 *    response into the query cache. On 502/404 show nothing and do NOT retry until the node
 *    is opened again (cost bound). Never POST for a `ready` node.
 *  - Invalidate `['suggestions', tree]` whenever the tree is refreshed: a question of the tree
 *    reached `done` or was removed, and after move/delete/restore/rename/undo and tree-title
 *    changes (ids and "used" state change; resolution is server-side). A node saved moments
 *    ago may briefly be `missing` while its at-save generation finishes; the POST joins it.
 *
 * Visibility (on top of the server's list)
 *  - Hide a suggestion if the client's question store holds an entry (any status: streaming,
 *    naming, done, failed) with `tree` equal, `parentId === suggestion.target` and
 *    `suggestionKey(entry.text) === suggestionKey(suggestion.text)`. This covers the window
 *    between the 202 and the next GET.
 *  - Nothing while the focused node's own answer is streaming (it is not a saved node yet).
 *
 * Clicking
 *  - Send `POST /api/trees/:tree/questions` with `{ parentId: target, text, model: <panel's
 *    selected model>, namingModel: <as the composer sends it>, context: <panel's context> }`,
 *    JSON, no files. The composer draft is untouched; on a pre-202 failure show the usual
 *    error notice (nothing goes into the composer). Disable the button while its send is
 *    pending (at most one question per click).
 *  - SIDE PANEL caveat (server rule unchanged): `context.anchor` must be `parentId` or one of
 *    its ancestors, else 400. An inherited target ABOVE the side panel's anchor would violate
 *    it — the web decides (hide such items in the side panel, or send them with
 *    `anchor: target`); see the web plan.
 */
export type ClientRules = never;
