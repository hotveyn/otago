/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 * Data model of a RESOLVED suggestion (what clients render), the text rules, and the two
 * algorithms every implementation (server, demo mock) must apply identically: resolution on
 * read and finalization after generation.
 *
 * Pure helpers live in `server/src/storage/suggestions.ts`, which imports nothing but
 * `server/src/text.ts` (no Node APIs), so `demo/src/mock/` can import them as-is.
 */
import type { StoredSuggestion } from './node-file';
import type { NodeId } from './shared';

/** One button. Returned by ./suggestions-api.ts. */
export interface Suggestion {
  /** Button label AND the question text to send, verbatim. Single line, NFC, ≤ 200 graphemes. */
  text: string;
  /**
   * Node to ask from = `parentId` of the question to start. The viewed node itself for own
   * suggestions, an ancestor (never `""`) for inherited ones. Current id (resolved on read).
   */
  target: NodeId;
  /**
   * Levels above the viewed node (`0` = own). Inherited ⇔ `up > 0`. Clients label inherited
   * buttons with the source, e.g. the target's display name (last id segment, `<bdi>`,
   * `dir="auto"`).
   */
  up: number;
}

/** At most this many items are stored per node (own first, then inherited). */
export const MAX_SUGGESTIONS = 5;
/** Text cap, in graphemes (`server/src/text.ts` `truncateGraphemes`, no ellipsis). */
export const SUGGESTION_MAX_GRAPHEMES = 200;

/**
 * `suggestionKey(text) = text.trim().normalize('NFC')` — the ONE equality used everywhere:
 * dedupe, inherited-validation, "already asked" and "used" checks. Case-sensitive.
 * Clients use the same function for the in-flight check (web has its own copy; demo imports).
 */
export type SuggestionKey = (text: string) => string;

/**
 * `sanitizeSuggestionText(raw): string | null`, in order:
 *   1. not a string → null;
 *   2. `toWellFormed()` (lone surrogates → U+FFFD), NFC;
 *   3. collapse every whitespace run (incl. newlines, U+2028/U+2029) to one space, trim;
 *   4. strip ONE pair of wrapping quotes if the whole text is wrapped (`"…"`, `'…'`, `«…»`,
 *      `“…”`, `„…“`), then trim again;
 *   5. cut to SUGGESTION_MAX_GRAPHEMES graphemes (no ellipsis), trim;
 *   6. empty → null.
 */
export type SanitizeSuggestionText = (raw: unknown) => string | null;

/**
 * RESOLUTION ON READ — `resolveSuggestions(chain, usedKeysByTarget)`.
 *
 * Input: the chain from the top-level node down to the viewed node V (V last; every element
 * `{ id, suggestions?: StoredSuggestion[] }` as parsed from node.md), and for each target the
 * set of `suggestionKey(child.user)` of its LIVE children (soft-deleted folders don't count).
 * Output: `Suggestion[]` or `'missing'` when V's list is missing.
 *
 *   if V.suggestions === undefined → 'missing'   (ancestors are NOT consulted; no fallback)
 *   for item of V.suggestions, in stored order:
 *     up === 0                      → target = V.id
 *     up ≥ chain.length             → drop (would be the tree root or above)
 *     A = chain[chain.length-1-up]
 *     A.suggestions undefined       → drop (source has no list, e.g. after a move)
 *     no OWN item (up 0) of A with the same key → drop (source no longer offers it: the node
 *                                     was moved under another parent, or a hand edit)
 *     else                          → target = A.id
 *   dedupe by key: first occurrence wins (own items are stored first, so own wins);
 *   drop items whose key ∈ usedKeysByTarget[target] (a live child of the target already asks
 *     exactly this question — "used");
 *   cap at MAX_SUGGESTIONS (defensive; stored lists already are).
 *
 * Moves/renames/deletes/restores need no bookkeeping: everything is relative and re-resolved
 * against the live tree on every read. The server applies the "used" filter (only it can see
 * siblings' question texts cheaply). Clients apply the in-flight filter (./suggestions-api.ts
 * "client rules").
 */
export type ResolveSuggestions = (
  chain: Array<{ id: NodeId; suggestions?: StoredSuggestion[] }>,
  usedKeysByTarget: ReadonlyMap<NodeId, ReadonlySet<string>>,
) => Suggestion[] | 'missing';

/**
 * Candidate offered to the generator for inheritance (server-internal, see ./generation.ts).
 * `origin` = index in the generation chain of the node that OWNS the text (up 0 there).
 */
export interface SuggestionCandidate {
  text: string;
  /** Id of the owning ancestor (for the prompt label). */
  source: NodeId;
  /** Index of the owning ancestor in the generation chain (0 = top-level node). */
  origin: number;
}

/**
 * What the generator (Agent.suggest, ./generation.ts) returns: new own texts and/or picks of
 * candidates (0-based index into the candidates array given to it).
 */
export type SuggestPick = { text: string } | { keep: number };

/**
 * FINALIZATION AFTER GENERATION — `finalizeSuggestions(picks, candidates, ctx)` →
 * `StoredSuggestion[]` (may be `[]`). `ctx.depth` = number of ancestors of the new/target node
 * N (its parent chain length); `ctx.askedKeys` = keys of `user` of every ancestor AND of N
 * itself (questions already asked along the chain).
 *
 *   for pick in model order:
 *     { keep: i }  → candidate c = candidates[i] (out of range / non-integer → drop);
 *                    item = { text: c.text (VERBATIM, no re-sanitize), up: depth - c.origin }
 *     { text }     → t = sanitizeSuggestionText(text) (null → drop);
 *                    if key(t) equals a candidate's key → treat as { keep: that candidate };
 *                    else item = { text: t, up: 0 }
 *     drop if key ∈ askedKeys
 *   dedupe by key (first wins); stable-partition: own (up 0) first, then inherited, each in
 *   model order; cap at MAX_SUGGESTIONS.
 * Zero picks / everything dropped → `[]` (STORED, EMPTY). Only an unparseable reply or a
 * failed/timed-out call is a failure (→ MISSING).
 */
export type FinalizeSuggestions = (
  picks: SuggestPick[],
  candidates: SuggestionCandidate[],
  ctx: { depth: number; askedKeys: ReadonlySet<string> },
) => StoredSuggestion[];
