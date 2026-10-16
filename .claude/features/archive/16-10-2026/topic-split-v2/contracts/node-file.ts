/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * node.md storage of suggestions. Format, key, states (absent / `[]` / list) and the single
 * writer (`createNode` via `serializeNodeFile`) are UNCHANGED; the stored ITEM gains one
 * optional key.
 *
 * Mirrored by: `server/src/storage/suggestions.ts` (pure, Node-free) + `storage/format.ts`;
 * demo `demo/src/mock/format.ts` (imports the pure helpers).
 */
import type { BlockItemKind } from './block';

/** CHANGED: optional `kind`. */
export interface StoredSuggestion {
  /** Sanitized question text, sent verbatim when clicked. UNCHANGED. */
  text: string;
  /**
   * Levels above this node the question is asked from. UNCHANGED meaning. A `whole` item always
   * has `up: 1` (asked from this node's parent; the tree root for a top-level node).
   */
  up: number;
  /**
   * NEW, optional. Absent = regular suggestion (every existing node). `'whole'` = the
   * "explain it whole" item of a map node. At most one `whole` item per list, stored LAST.
   */
  kind?: BlockItemKind;
}

/**
 * Example frontmatter line of a top-level map node `глава-4` (one line, as today):
 *
 *   suggestions: [{"text":"Объясни первую часть главы 4: владение","up":0},{"text":"Объясни вторую часть главы 4: заимствование","up":0},{"text":"Объясни главу 4 целиком, одним ответом, без разбиения","up":1,"kind":"whole"}]
 */
export type StoredExample = never;

/**
 * WRITER (`suggestionsLine`) — CHANGED: emits `{ text, up }` for regular items and
 * `{ text, up, kind }` (this key order) for items with a `kind`. Nothing else is written.
 * A list without `whole` items serializes byte-identically to today.
 *
 * READER (`parseStoredSuggestions`) — CHANGED, per item, on top of today's rules (record, text
 * sanitized non-empty, `up` safe integer ≥ 0):
 *  - `kind` absent (or `undefined`)          → regular item `{ text, up }`
 *  - `kind === 'whole'` and `up === 1`       → `{ text, up: 1, kind: 'whole' }`
 *  - `kind === 'whole'` with any other `up`  → item dropped (hand edit / corruption)
 *  - any other `kind` value (unknown string, non-string, `null`) → item dropped: an unknown
 *    special item must never show up as a regular button (forward compatibility)
 *  - every other unknown key                 → ignored (UNCHANGED)
 * The reader does not reorder or dedupe; resolution handles "first whole wins" (./suggestions.ts).
 *
 * Old nodes (no `kind` anywhere, v1 map nodes included) parse exactly as before (E: "Old v1 map
 * nodes stay as they are; no special button").
 */
export type ReadWriteRules = never;

/** Runtime `NodeFile` (`storage/format.ts`). UNCHANGED apart from the item type above. */
export interface NodeFile {
  created: string;
  model: string;
  user: string;
  assistant: string;
  suggestions?: StoredSuggestion[];
}
