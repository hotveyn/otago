/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 * Storage format: where and how a node's suggestions live in `node.md`.
 *
 * Mirrored by:
 *  - server: `server/src/storage/suggestions.ts` (pure, Node-free) + `storage/format.ts`;
 *  - demo:   `demo/src/mock/format.ts` (flat frontmatter parser) — it may import the pure
 *            helpers from `server/src/storage/suggestions.ts` directly, like node-names.ts.
 */

/**
 * One stored suggestion. Item shape is OPEN: readers ignore unknown keys (seam for e.g. a
 * `kind` or `id` later, no format break). Writers today emit exactly `{ text, up }`.
 */
export interface StoredSuggestion {
  /**
   * Full question text, sent verbatim when clicked. Already sanitized (./suggestions.ts
   * `sanitizeSuggestionText`): NFC, single line, trimmed, 1..SUGGESTION_MAX_GRAPHEMES graphemes.
   */
  text: string;
  /**
   * Where the question is asked from, RELATIVE to this node (survives renames of the node and
   * its ancestors): `0` = this node (own suggestion), `k ≥ 1` = the ancestor k levels up
   * (inherited; `1` = parent). Non-negative integer. Never points at the tree root `""`:
   * `up ≤ depth(node) - 1` where a top-level node has depth 1 (an item pointing higher is
   * dropped on read).
   *
   * Invariant written by the server: an inherited item's `text` is byte-identical to an OWN
   * (`up: 0`) item of the ancestor it points at — inheritance is always recorded against the
   * node that originally offered the suggestion, never against an intermediate node that
   * only inherited it.
   */
  up: number;
}

/**
 * Frontmatter key. node.md example (new node, saved with suggestions):
 *
 *   ---
 *   created: 2026-10-15T10:00:00.000Z
 *   model: claude-opus-5-5
 *   suggestions: [{"text":"Перейдём к главе 2","up":1},{"text":"Что такое заимствование?","up":0}]
 *   ---
 *   <!-- otago:user -->
 *   …
 *
 * States (the distinction is the whole point of the format):
 *  - key ABSENT                  → MISSING: not generated yet (old node) or generation failed.
 *                                  Lazy generation may run (./suggestions-api.ts POST).
 *  - `suggestions: []`           → STORED, EMPTY: generated, nothing obvious. Never regenerated.
 *  - `suggestions: [ …items ]`   → STORED. Never regenerated (no regenerate button, non-goal).
 *  - any other value (not an array: `null`, a string, a map, unparseable YAML/JSON)
 *                                → treated as MISSING (may be regenerated; the writer then
 *                                  replaces that value).
 * Invalid ITEMS inside an array are dropped one by one on read (text not a non-empty string,
 * `up` not a non-negative safe integer); the list itself stays STORED (possibly empty).
 * Item `text` is re-sanitized on read (cheap; protects against hand edits).
 */
export const SUGGESTIONS_KEY = 'suggestions';

/**
 * WRITE FORM (mandatory for every writer: server and demo):
 *  - exactly ONE line `suggestions: <json>` where `<json>` = `JSON.stringify(items)` with
 *    U+2028 / U+2029 additionally escaped as ` ` / ` ` (sanitized text never
 *    contains them; belt and braces). JSON is valid YAML flow, so gray-matter / js-yaml parses
 *    it (verified), and the demo's flat `key: value` parser reads it as one raw string and
 *    `JSON.parse`s it.
 *  - order of items = display order (own first, then inherited; see ./suggestions.ts).
 *  - the line sits inside the frontmatter block: at the place of an existing top-level
 *    `suggestions:` key (replacing it and its continuation lines — lines that start with
 *    whitespace or `-`), otherwise as the LAST line before the closing `---`.
 *  - line ending = the file's own (`\r\n` if the opening `---` line ends with `\r\n`, else `\n`).
 *
 * READ FORM: the server reads the parsed frontmatter value (gray-matter), so a hand-edited
 * block-style YAML list is also accepted. The demo only needs to read the write form.
 */
export type SuggestionsLine = `suggestions: ${string}`;

/**
 * Serialization rules:
 *  1. NEW node (`createNode` at commit): `serializeNodeFile` emits today's frontmatter
 *     (`created`, `model`, via gray-matter) and, when the node has a stored list (even `[]`),
 *     appends the suggestions line before the closing `---`. A node committed while its
 *     generation is still running or after it failed has NO key (missing).
 *  2. NodeFile WITHOUT suggestions serializes byte-identically to today (round-trip of old
 *     nodes unchanged).
 *  3. LATER write (lazy generation, or an at-save generation that finished after the commit):
 *     a TEXTUAL SPLICE of the raw file read during verification — only the suggestions line
 *     is inserted/replaced; every other byte (frontmatter, markers, user and assistant text)
 *     is preserved. Never re-serialize the whole file for this. Atomic: temp file in the SAME
 *     node folder + rename (`writeFileAtomic`), so a concurrent move/delete makes the rename
 *     fail (ENOENT) instead of writing elsewhere or recreating a folder.
 */
export type SerializationRules = never;

/** Runtime `NodeFile` (server `storage/format.ts`), CHANGED: optional `suggestions`. */
export interface NodeFile {
  created: string;
  model: string;
  user: string;
  assistant: string;
  /** NEW. `undefined` = MISSING (key absent or not an array); array = STORED (maybe empty). */
  suggestions?: StoredSuggestion[];
}
