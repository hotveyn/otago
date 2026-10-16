/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * HTTP surface. No route, status code, error code or lock changes.
 */
import type { NodeId } from './shared';
import type { Suggestion } from './suggestions';

/**
 * `GET /api/trees/:tree/suggestions?node=<NodeId>` — envelope UNCHANGED, items may carry
 * `kind: 'whole'` (./suggestions.ts). Status table UNCHANGED (200 always `ready`; 400 root /
 * malformed; 404 tree / node; never 409).
 */
export interface SuggestionsReady {
  node: NodeId;
  state: 'ready';
  /** Own regular, then inherited, then at most one `whole` item (last). */
  suggestions: Suggestion[];
}

export type SuggestionsResponse = SuggestionsReady;

/**
 * CLIENT RULES (web; the demo mock reproduces the server side). Web-owned details (look,
 * placement, focus mechanics) are decided in the web plan; the contract fixes only:
 *
 *  - Rendering: an item with `kind: 'whole'` is the "explain it whole" button; it may be styled
 *    distinctly. It only ever appears in the response for the map node itself (`up: 1`). An
 *    item with an unknown `kind` is not rendered.
 *  - Sending: `{ parentId: item.target, text: item.text, … }` through the same guarded
 *    `store.ask` path as other suggestions. `item.target` may be `""` (top-level map → new
 *    top-level node). The panel's own `context` is sent unchanged (valid, see ./shared.ts).
 *  - Focus: after the 202 the panel that showed the map node focuses the new in-flight question
 *    and follows it to the saved node (a sibling of the map node), like a send from that panel.
 *  - Visibility rules UNCHANGED and they apply to `whole` too: hidden while a store entry with
 *    the same `target` and `suggestionKey` is in flight / not acked; the side-panel "target
 *    above the anchor" rule (a map shown as a side head always has its parent at or below the
 *    anchor, so the button stays). The web's "own beats inherited" dedupe must not drop a
 *    `whole` item (it has `up: 1` but is not inherited; texts never collide with own items
 *    because the server dedupes by key).
 *  - Invalidation UNCHANGED (`['suggestions', tree]` after a question of the tree is done /
 *    removed and after structural edits): the "whole" node becomes a live child of the target,
 *    so the next GET drops the button.
 */
export type ClientRules = never;
