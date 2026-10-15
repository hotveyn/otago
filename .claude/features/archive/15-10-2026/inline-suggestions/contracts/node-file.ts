/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * Storage format of a node's suggestions in `node.md`. The FORMAT is UNCHANGED from
 * `suggested-prompts` (one frontmatter line `suggestions: <json>`, items `{ text, up }`,
 * readers ignore unknown item keys). What changes is the meaning of an absent key and who
 * writes the line.
 *
 * Mirrored by:
 *  - server: `server/src/storage/suggestions.ts` (pure, Node-free) + `storage/format.ts`;
 *  - demo:   `demo/src/mock/format.ts` (imports the pure helpers from the server module).
 */

/**
 * One stored suggestion. UNCHANGED. Item shape stays OPEN (readers ignore unknown keys; seam
 * for later fields without a format break). Writers emit exactly `{ text, up }`.
 */
export interface StoredSuggestion {
  /** Sanitized question text (`sanitizeSuggestionText`), sent verbatim when clicked. */
  text: string;
  /**
   * Where the question is asked from, relative to this node: `0` = own, `k ≥ 1` = the ancestor
   * k levels up. Invariant written by the server: an inherited item's text is identical to an
   * OWN item of the ancestor it points at (the original owner, never an intermediate node).
   */
  up: number;
}

/** Frontmatter key. UNCHANGED. */
export const SUGGESTIONS_KEY = 'suggestions';

/**
 * STATES (CHANGED meaning of an absent key):
 *  - key ABSENT                → NO OWN LIST. The answer had no block, its block was rejected,
 *                                or the node predates suggestions / was saved by the old
 *                                generator path without a list. On read the node shows the
 *                                resolved list of its nearest ancestor with a stored list
 *                                (./suggestions.ts). Never generated later (no lazy path).
 *  - `suggestions: []`         → STORED, EMPTY: the agent wrote an empty block on purpose (or
 *                                the old generator stored nothing, or every item was dropped by
 *                                finalization). Shows nothing and STOPS inheritance (E2).
 *  - `suggestions: [ …items ]` → STORED. Own items first, then kept inherited ones.
 *  - any other value (not an array) → treated as ABSENT (unchanged reader rule).
 * Invalid items inside an array are dropped one by one on read; texts are re-sanitized.
 * Existing files, including lists written by the old generator, are read as they are; nothing
 * is migrated or rewritten (E9).
 */
export type SuggestionStates = never;

/**
 * WRITE FORM: UNCHANGED (one line `suggestions: <JSON.stringify(items)>`, U+2028/U+2029
 * escaped, placed before the closing `---`, file's own line ending).
 *
 * SERIALIZATION RULES (CHANGED):
 *  1. The ONLY writer is `createNode` at the question's commit (`serializeNodeFile`): the node
 *     is created with the line when the answer carried a valid block (even an empty one →
 *     `suggestions: []`) and without the key otherwise.
 *  2. A NodeFile without `suggestions` serializes byte-identically to the pre-suggestions format.
 *  3. REMOVED: the later textual splice (`writeNodeSuggestions`, verified write). No code path
 *     writes suggestions into an existing node any more. `setSuggestionsLine` /
 *     `removeSuggestionsLine` stay as helpers of `serializeNodeFile` / the tolerant parser.
 */
export type SerializationRules = never;

/** Runtime `NodeFile` (server `storage/format.ts`). UNCHANGED. */
export interface NodeFile {
  created: string;
  model: string;
  user: string;
  /** Stored answer, block removed. */
  assistant: string;
  /** `undefined` = no own list (key absent or not an array); array = STORED (maybe empty). */
  suggestions?: StoredSuggestion[];
}
