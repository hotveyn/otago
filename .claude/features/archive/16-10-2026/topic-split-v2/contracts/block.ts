/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * The "explain it whole" item inside the suggestion block. Implemented in
 * `server/src/storage/suggestion-block.ts` (stays PURE and Node-free, imports nothing; the demo
 * imports it as-is).
 *
 * UNCHANGED: `SUGGESTIONS_MARKER`, every line class (MARKER / ITEM / BLANK / FENCE), the
 * recognition grammar, `SuggestionBlockFilter`, `splitSuggestionBlock` and `SplitAnswer`
 * (`items` stay RAW strings — the prefix is still part of the raw item text there).
 */

/**
 * NEW. Canonical prefix of the "whole" item (what the prompt asks for and what `wholeItem`
 * writes). An HTML comment like the block marker: cannot collide with a real question, and if a
 * block is ever rejected and stays in the answer, rendered Markdown hides it.
 *
 * Example block as the agent streams it (map answer to "Разбери главу 4"):
 *
 *   <!-- otago:suggestions -->
 *   - Объясни первую часть главы 4: владение
 *   - Объясни вторую часть главы 4: заимствование
 *   - Объясни третью часть главы 4: срезы
 *   - <!-- otago:whole --> Объясни главу 4 целиком, одним ответом, без разбиения
 *
 * Every line is an ITEM line for the existing grammar (`- ` + text), so nothing about block
 * recognition or streaming changes: the whole block, the special line included, is withheld.
 */
export const WHOLE_ITEM_PREFIX = '<!-- otago:whole -->';

/**
 * NEW. Recognizes the prefix at the start of a RAW item text (group 1 of ITEM_LINE_RE, i.e.
 * after the bullet and its spaces). Case-sensitive like the marker; spaces / tabs allowed inside
 * the comment and after it; group 1 = the rest of the item (the request text, unsanitized).
 *
 *   WHOLE_ITEM_RE = /^<!--[ \t]*otago:whole[ \t]*-->[ \t]*(.*)$/
 *
 * Only a prefix counts: `- Объясни <!-- otago:whole --> …` is a regular item whose text contains
 * the comment (sanitized as usual). A standalone `<!-- otago:whole -->` line (no bullet) is NOT
 * an item line: as today, it breaks the candidate block (rejected → the block stays in the
 * answer, the runner logs the existing warning). The prompt shows the exact form to avoid it.
 */
export type WholeItemGrammar = never;

/** Kinds a block item can have. `undefined` = a regular suggestion. Open union (later kinds). */
export type BlockItemKind = 'whole';

/** NEW. One raw block item, classified. */
export interface BlockItem {
  /** The item text without the prefix (still raw: finalization sanitizes it). */
  text: string;
  /** `'whole'` when the raw text starts with the prefix; absent for a regular item. */
  kind?: BlockItemKind;
}

/**
 * NEW pure helper `parseBlockItem(raw)`: `WHOLE_ITEM_RE` matches → `{ text: group 1, kind:
 * 'whole' }`; otherwise `{ text: raw }`. Used by `finalizeSuggestions` (./suggestions.ts).
 * Lives in `suggestion-block.ts`; `suggestions.ts` imports it from there by file
 * (`./suggestion-block.js`), and `suggestion-block.ts` keeps importing nothing (no cycle).
 */
export type ParseBlockItem = (raw: string) => BlockItem;

/**
 * NEW pure helper `wholeItem(text)` → `${WHOLE_ITEM_PREFIX} ${text}`: a raw item text for
 * `suggestionBlock` (tests, demo simulator). Example:
 *   suggestionBlock(['Part one', 'Part two', wholeItem('Explain it whole')])
 *   → "\n\n<!-- otago:suggestions -->\n- Part one\n- Part two\n- <!-- otago:whole --> Explain it whole"
 * `splitSuggestionBlock` of that returns the three raw texts unchanged (round trip; the prefix
 * is in the third), and `parseBlockItem` of the third returns `{ text: 'Explain it whole',
 * kind: 'whole' }`.
 */
export type WholeItemWriter = (text: string) => string;

/** `suggestionBlock(texts)` UNCHANGED (texts may now carry the prefix via `wholeItem`). */
export type SuggestionBlockWriter = (texts: readonly string[]) => string;
