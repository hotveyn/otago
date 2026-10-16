/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * Resolved suggestions and the pure algorithms (`server/src/storage/suggestions.ts`, imported
 * as-is by the demo). Only the parts touched by the "whole" item are restated; everything else
 * is the archived `inline-suggestions/contracts/suggestions.ts`.
 */
import type { BlockItemKind } from './block';
import type { StoredSuggestion } from './node-file';
import type { NodeId } from './shared';

/** One button. CHANGED: optional `kind`; `target` may be `""` for `kind: 'whole'`. */
export interface Suggestion {
  /** Button label AND the question text to send, verbatim. UNCHANGED rules. */
  text: string;
  /**
   * Node to ask from (`parentId` of the question to start). Current id.
   * Regular items: never `""` (UNCHANGED). `whole`: the PARENT of the viewed (map) node —
   * `""` when the map node is top-level (the tree root).
   */
  target: NodeId;
  /** Levels between the viewed node and `target`. Always `1` for `whole`. */
  up: number;
  /**
   * NEW, optional. Absent = regular suggestion. `'whole'` = "explain it whole": send it to
   * `target` (the map's parent) and move the panel's focus to the new question. Clients must
   * treat an unknown `kind` value as "do not render" (forward compatibility).
   */
  kind?: BlockItemKind;
}

/** A chain element (top-level first). UNCHANGED shape (items may now carry `kind`). */
export interface SuggestionChainNode {
  id: NodeId;
  user: string;
  suggestions?: StoredSuggestion[];
}

/**
 * NEW constant: minimum number of own regular items (`up: 0`, no `kind`) a finalized list needs
 * for its `whole` item to be kept (a map has at least two parts). Server-internal + demo.
 */
export const MIN_SPLIT_PARTS = 2;

/**
 * `suggestionTargets(chain)` — CHANGED: as today over the effective list S =
 * nearestStoredIndex(chain), with `whole` items handled first:
 *   whole item: contributes only when S === last (V has its own list; no inheritance) →
 *               target `wholeTarget(chain, S)`; otherwise skipped.
 *   other items: UNCHANGED.
 * `wholeTarget(chain, S) = S >= 1 ? chain[S - 1].id : ""`. `readUsedKeys` already maps `""` to
 * the tree's top-level children (`readChildQuestionKeys(treeDir, "")`).
 * (Called from `readCandidates` too: there the extra target only costs one directory scan.)
 */
export type SuggestionTargets = (chain: readonly SuggestionChainNode[]) => NodeId[];

/**
 * RESOLUTION — `resolveSuggestions(chain, usedKeysByTarget)` — CHANGED by one branch, taken
 * BEFORE today's `up > S` / owner checks:
 *
 *   for item of chain[S].suggestions, in stored order:
 *     if item.kind === 'whole':
 *       shift > 0                  → skip (never inherited through the fallback)
 *       a whole item already emitted → skip (first wins)
 *       target = wholeTarget(chain, S)  (no owner validation; `""` for a top-level map)
 *       dedupe by key against everything emitted so far (shared `seen` set) → skip if seen
 *       key ∈ usedKeysByTarget[target] → skip ("used": a live child of the parent asks it —
 *                                          the "whole" node itself after the click, or the
 *                                          same text asked by hand)
 *       emit { text, target, up: 1, kind: 'whole' }
 *     else: UNCHANGED (own / inherited / fallback / owner validation / used / below)
 *
 * Unknown kinds never reach here (dropped by the reader). Example — top-level map `глава-4`
 * storing [p1 up 0, p2 up 0, whole up 1]: GET node=глава-4 →
 *   [{ text: p1, target: 'глава-4', up: 0 }, { text: p2, target: 'глава-4', up: 0 },
 *    { text: whole, target: '', up: 1, kind: 'whole' }].
 * Child `глава-4/часть-1` without its own list → [{ p2, target 'глава-4', up 1 }] (p1 is asked
 * below; whole skipped). A map nested under `P` → whole target `P`.
 */
export type ResolveSuggestions = (
  chain: readonly SuggestionChainNode[],
  usedKeysByTarget: ReadonlyMap<NodeId, ReadonlySet<string>>,
) => Suggestion[];

/**
 * CANDIDATES — `pickCandidates(ancestors, used, askedKeys)` — CHANGED: resolved items with a
 * `kind` (i.e. `whole`) are filtered out BEFORE mapping. So a "whole" text never appears in
 * `<open-suggestions>` and can never be kept by a child's block.
 * `SuggestionCandidate` shape UNCHANGED (`{ text, source, origin }`).
 */
export type PickCandidates = never;

/**
 * FINALIZATION AT SAVE — `finalizeSuggestions(texts, candidates, ctx)` — CHANGED. Signature
 * UNCHANGED (`texts` = raw block items from `splitSuggestionBlock`).
 *
 *   for raw of texts, in block order:
 *     { text: rawText, kind } = parseBlockItem(raw)                       (./block.ts)
 *     t = sanitizeSuggestionText(rawText); null → drop
 *     kind === 'whole':
 *       item = { text: t, up: 1, kind: 'whole' }    (never matched against candidates)
 *     else: UNCHANGED (candidate match → keep with `up = depth - origin`; else own `up: 0`)
 *     drop if key(item.text) ∈ askedKeys                                    (UNCHANGED)
 *     dedupe by key across ALL items, block order, first wins              (UNCHANGED)
 *     whole: drop if a whole item was already accepted                     (keep the first)
 *   own   = accepted items with up 0 and no kind, block order
 *   kept  = accepted items with up > 0 and no kind, block order
 *   whole = the accepted whole item, if any
 *   result = [...own, ...kept, ...(whole && own.length >= MIN_SPLIT_PARTS ? [whole] : [])]
 *
 * Notes: a block whose only item is `whole` (or whose whole is dropped and nothing else
 * remains) yields `[]` — STORED, EMPTY, as today for a fully dropped block. `ctx.depth` is not
 * needed for `whole` (`up` is always `1`; the target is resolved from the chain on read).
 */
export type FinalizeSuggestions = never;
