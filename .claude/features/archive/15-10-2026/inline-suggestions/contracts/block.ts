/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 * NEW. The suggestion block the answering agent may append to its answer: syntax, how the server
 * recognizes it in the final text, and how it is withheld while streaming.
 *
 * Implemented in `server/src/storage/suggestion-block.ts`: PURE and Node-free (imports nothing
 * but `./suggestions.js` / `../text.js`), so `demo/src/mock/` imports it as-is (like
 * `server/src/storage/suggestions.ts`). One state machine serves both the streaming filter and
 * the final split, so they can never disagree on the same text.
 */

// ---------------------------------------------------------------------------
// Syntax (decision for feature open question 1)
// ---------------------------------------------------------------------------

/**
 * Canonical marker (what the prompt tells the agent to write and what `suggestionBlock` emits).
 *
 * Example answer as the agent streams it:
 *
 *   …the chapter ends with a summary [^3].
 *
 *   Can you name the three ownership rules?
 *
 *   [^3]: sources/the-book-ch4.md:300-312
 *
 *   <!-- otago:suggestions -->
 *   - Перейти к главе 4
 *   - Разбери вторую часть главы 3
 *
 * An HTML comment: invisible if it ever leaked into rendered Markdown, cannot collide with
 * normal prose, same family as the `<!-- otago:user -->` markers of node.md.
 */
export const SUGGESTIONS_MARKER = '<!-- otago:suggestions -->';

/**
 * Line classes (a "line" is the text between `\n`s; a trailing `\r` is ignored everywhere):
 *
 *  MARKER  /^[ \t]*<!--[ \t]*otago:suggestions[ \t]*-->[ \t]*\r?$/   (case-sensitive)
 *  ITEM    /^[ \t]*(?:[-*+•]|\d{1,3}[.)])(?:[ \t]+(.*?))?[ \t]*\r?$/
 *          raw item text = capture group 1 (or `""`). `-`, `*`, `+`, `•` bullets and `1.` / `1)`
 *          numbering are accepted; `---`, `***`, `-text` are NOT items.
 *  BLANK   /^[ \t]*\r?$/
 *  FENCE   open  /^ {0,3}(`{3,}|~{3,})/ ; close /^ {0,3}(`{3,}|~{3,})\s*$/ with the same fence
 *          character and a length ≥ the opening one (same rule as `removeFencedBlocks` in
 *          `server/src/agent/prompt.ts`). An unclosed fence runs to the end of the text.
 */
export type LineClasses = never;

/**
 * GRAMMAR / RECOGNITION (one left-to-right pass over the lines, state: `fence`, `blockStart`):
 *
 *   for each line L:
 *     if blockStart is set (inside a candidate block):
 *       L is BLANK or ITEM      → stays in the block
 *       otherwise               → the candidate is ABANDONED (rejected = true), blockStart is
 *                                 cleared, and L is processed again as a normal line (below)
 *     normal line:
 *       inside a fence          → fence closes if L is a matching FENCE close; nothing else
 *       L is a FENCE open       → enter fence
 *       L is a MARKER           → blockStart = L (a candidate block begins)
 *   end of text:
 *     blockStart set            → THE BLOCK = from the marker line to the end of the text
 *     otherwise                 → no block
 *
 * Consequences (binding):
 *  - E3: only a block at the very end counts. A marker inside a fenced code block never starts
 *    a block; a marker followed by any non-item, non-blank line (prose, footnotes, a fence, a
 *    closing ``` of an example) is ordinary answer text and STAYS in the answer, unchanged.
 *  - Several candidates: the last one that reaches the end wins; earlier ones stay as text.
 *  - The block may end without a trailing newline; a marker line alone at the end = EMPTY block.
 *  - Footnote definitions must come BEFORE the block (a footnote line after it breaks it; the
 *    prompt says so). A misplaced block is never cut out: answer text is never eaten.
 */
export type Grammar = never;

// ---------------------------------------------------------------------------
// Final split (at save) — `splitSuggestionBlock`
// ---------------------------------------------------------------------------

export interface SplitAnswer {
  /**
   * Answer to store, to name the node from, and to show: the text before the marker line with
   * trailing whitespace removed when a block was found; otherwise the input unchanged.
   */
  answer: string;
  /**
   * Raw item texts in block order, NOT sanitized (finalization does that; ./suggestions.ts).
   * `undefined` = no block (node saved without the key, E1); `[]` = empty block (E2).
   * Blank lines are skipped; an item line with no text yields `""` (dropped later).
   */
  items?: string[];
  /**
   * True when at least one marker line outside fences was seen but abandoned (no valid final
   * block came from it). The runner logs a warning; the text stays in the answer.
   */
  rejected: boolean;
}

/** Runs the grammar over the whole text (the same machine as the streaming filter). */
export type SplitSuggestionBlock = (text: string) => SplitAnswer;

// ---------------------------------------------------------------------------
// Streaming (E7) — `SuggestionBlockFilter`
// ---------------------------------------------------------------------------

/**
 * One instance per attempt. The runner passes every agent chunk through `push` and appends only
 * the returned text to the registry (`appendChunk` ignores `""`); after the agent's `done`
 * it appends `end()`. Cancel / failure / timeout: `end()` is never called, withheld text is
 * dropped with the attempt (E6).
 *
 * Holding rules (minimal latency, no partial marker ever emitted):
 *  - Normal mode, outside a fence: the current INCOMPLETE line is held iff its text with leading
 *    spaces/tabs removed is a prefix of `<!--` or starts with `<!--` (it may still become a
 *    marker line). Every other byte is emitted at once.
 *  - Inside a fence: everything is emitted at once (lines are still tracked to find the close).
 *  - When a held line completes (`\n` arrives): MARKER → enter block mode (keep holding);
 *    otherwise → emit it.
 *  - Block mode: everything is held. Each completed line that is neither BLANK nor ITEM ends
 *    block mode: everything held BEFORE that line is emitted, then that line is processed as a
 *    normal line (so a line that is itself a marker starts a new held block).
 *  - `end()`: the incomplete line (if any) is treated as complete. Still in block mode → returns
 *    `""` (the block is withheld for good); otherwise returns the held text.
 *
 * Invariants (tested):
 *  - For ANY split of a text T into chunks: concat(push(...)…, end()) ===
 *      T                                  when splitSuggestionBlock(T).items === undefined,
 *      T.slice(0, start of the marker line) when a block was found.
 *  - What was emitted at any moment is a prefix of the final emitted text (never retracted).
 *  - No emitted text ever contains a marker line that ends up starting the final block, nor any
 *    prefix of it (a marker split across chunks at any offset is held).
 * The SAVED answer is `splitSuggestionBlock(done.text).answer`; the streamed text is display
 * only (the web replaces it with the saved node after `done`).
 */
export interface SuggestionBlockFilter {
  /** Text that may be shown now (possibly `""`). */
  push(chunk: string): string;
  /** End of stream: held text that turned out not to be the final block (possibly `""`). */
  end(): string;
}

// ---------------------------------------------------------------------------
// Writing a block (demo mock simulator, tests)
// ---------------------------------------------------------------------------

/**
 * `suggestionBlock(texts)` → `"\n\n" + SUGGESTIONS_MARKER + "\n" + texts.map(t => "- " + t)
 * .join("\n")` (just `"\n\n" + SUGGESTIONS_MARKER` for `[]`). Appended to an answer it always
 * splits back into the same answer and the same items (texts must be single-line).
 */
export type SuggestionBlockWriter = (texts: readonly string[]) => string;
