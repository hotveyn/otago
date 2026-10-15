/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * Resolved suggestions (what clients render), text rules, and the algorithms every
 * implementation (server, demo mock) applies identically: resolution on read, candidates for
 * the agent, finalization of a block at save.
 *
 * Pure helpers live in `server/src/storage/suggestions.ts` (imports only `../text.js`, no Node
 * APIs); `demo/src/mock/` imports them as-is.
 */
import type { StoredSuggestion } from './node-file';
import type { NodeId } from './shared';

/** One button. UNCHANGED shape. */
export interface Suggestion {
  /** Button label AND the question text to send, verbatim. Single line, NFC, ≤ 200 graphemes. */
  text: string;
  /** Node to ask from (`parentId` of the question to start). Never `""`. Current id. */
  target: NodeId;
  /**
   * Levels between the VIEWED node and `target` (`0` = own). Inherited ⇔ `up > 0`. For a node
   * shown through the ancestor fallback (below) every item has `up > 0`.
   */
  up: number;
}

/** REMOVED: `MAX_SUGGESTIONS`. No cap anywhere (server stores all, clients show all). */
export type NoCap = never;

/** Text cap, in graphemes. UNCHANGED. */
export const SUGGESTION_MAX_GRAPHEMES = 200;

/** `suggestionKey(text) = text.trim().normalize('NFC')`. UNCHANGED (the one equality). */
export type SuggestionKey = (text: string) => string;

/**
 * `sanitizeSuggestionText(raw)`: UNCHANGED (well-formed, NFC, one line, one pair of wrapping
 * quotes stripped, ≤ SUGGESTION_MAX_GRAPHEMES graphemes, empty → null). Applied to every block
 * item (E4) — a leading list bullet is already removed by the block parser.
 */
export type SanitizeSuggestionText = (raw: unknown) => string | null;

/** A chain element as far as suggestions are concerned (top-level first). */
export interface SuggestionChainNode {
  id: NodeId;
  /** The node's question (used for the fallback's "asked below the owner" filter). */
  user: string;
  suggestions?: StoredSuggestion[];
}

/**
 * `nearestStoredIndex(chain)`: index of the last element with a stored list (`suggestions !==
 * undefined`, `[]` included); `-1` when none. UNCHANGED.
 */
export type NearestStoredIndex = (chain: readonly SuggestionChainNode[]) => number;

/**
 * `suggestionTargets(chain)`: CHANGED — computed on the EFFECTIVE list: S =
 * nearestStoredIndex(chain) (V itself when it has a list); for each item of chain[S] the owner
 * chain[S - up] (items with `up > S` skipped). Distinct ids, in item order. `[]` when S = -1.
 * These are the nodes whose live children decide "used".
 */
export type SuggestionTargets = (chain: readonly SuggestionChainNode[]) => NodeId[];

/**
 * RESOLUTION ON READ — `resolveSuggestions(chain, usedKeysByTarget): Suggestion[]`. CHANGED:
 * never `'missing'`; ancestor fallback (E1); no cap.
 *
 *   V = chain[last]; S = nearestStoredIndex(chain); if S === -1 → []
 *   shift = last - S                      (0 when V has its own list)
 *   below = { key(chain[j].user) : S < j ≤ last }   (questions asked under the list's node)
 *   for item of chain[S].suggestions, in stored order:
 *     up === 0                         → target = chain[S].id
 *     up > S                           → drop (would be the tree root or above)
 *     A = chain[S - up]
 *     A.suggestions undefined          → drop
 *     no OWN item (up 0) of A with the same key → drop (moved / hand edit; E8)
 *     else                             → target = A.id
 *     dedupe by key (first wins; own items are stored first)
 *     drop if key ∈ usedKeysByTarget[target]  ("used": a live child of the target asks it)
 *     drop if shift > 0 and key ∈ below      (V or a node between asked it already)
 *     emit { text: item.text, target, up: item.up + shift }
 *
 * Examples: V has its own list → exactly the old algorithm without the cap. V has no key and its
 * parent P stores `[{ text: 'Глава 4', up: 0 }]` → V shows `{ text: 'Глава 4', target: P,
 * up: 1 }` unless a live child of P (V included) asks 'Глава 4'. V stores `[]` → `[]` (no
 * fallback past an empty list: E2). No stored list anywhere on the chain → `[]`.
 */
export type ResolveSuggestions = (
  chain: readonly SuggestionChainNode[],
  usedKeysByTarget: ReadonlyMap<NodeId, ReadonlySet<string>>,
) => Suggestion[];

/**
 * Candidate offered to the answering agent (server-internal + demo). UNCHANGED shape.
 * `origin` = index in the chain of the ancestor that OWNS the text (up 0 there).
 */
export interface SuggestionCandidate {
  text: string;
  source: NodeId;
  origin: number;
}

/**
 * CANDIDATES — `pickCandidates(ancestors, usedKeysByTarget, askedKeys)`. CHANGED: defined through
 * the new resolution and uncapped.
 *   P = ancestors = the chain of the new node's PARENT (top-level first; `[]` for a top-level
 *       question → no candidates).
 *   resolved = resolveSuggestions(ancestors, used)          (the list the parent shows, E1
 *                                                           fallback included)
 *   minus items whose key ∈ askedKeys                      (askedKeys = key of every ancestor's
 *                                                           `user` + key of the new question)
 *   map item → { text, source: item.target, origin: ancestors.length - 1 - item.up }
 * So the agent gets exactly the parent's visible, still-unused suggestions (S2, S4).
 * Disk side: `readCandidates(treeDir, ancestors, askedKeys)` scans the live children of
 * `suggestionTargets(ancestors)` for `used`.
 */
export type PickCandidates = (
  ancestors: readonly SuggestionChainNode[],
  usedKeysByTarget: ReadonlyMap<NodeId, ReadonlySet<string>>,
  askedKeys: ReadonlySet<string>,
) => SuggestionCandidate[];

/** REMOVED: `SuggestPick` (`{ text } | { keep }`). Blocks carry texts only. */
export type NoPicks = never;

/**
 * FINALIZATION AT SAVE — `finalizeSuggestions(texts, candidates, ctx)` → `StoredSuggestion[]`
 * (may be `[]`). CHANGED: input is the block's raw item texts; no cap.
 *   ctx.depth     = ancestors.length (the new node's parent chain length)
 *   ctx.askedKeys = the same set as for pickCandidates
 *
 *   for raw of texts, in block order:
 *     t = sanitizeSuggestionText(raw); null → drop                       (E4: empty)
 *     c = first candidate with key(c.text) === key(t)
 *       c found → item = { text: c.text (verbatim), up: depth - c.origin }   (a KEEP, E5: the
 *                 owner comes from the server's own candidate, so text and owner are verified;
 *                 `up < 1` → drop, defensive)
 *       else    → item = { text: t, up: 0 }   (a NEW own item; also any edited/unknown copy of
 *                 a candidate, E5)
 *     drop if key(item.text) ∈ askedKeys                                  (E4: already asked)
 *     dedupe by key (first wins)                                          (E4: duplicates)
 *   stable partition: own (up 0) first, then inherited, each in block order. NO cap.
 * A block whose items are all dropped → `[]` (STORED, EMPTY), same as an empty block.
 */
export type FinalizeSuggestions = (
  texts: readonly string[],
  candidates: readonly SuggestionCandidate[],
  ctx: { depth: number; askedKeys: ReadonlySet<string> },
) => StoredSuggestion[];
