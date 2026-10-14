/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * Server-internal: how a node gets its name. The web never sees this; recorded so the full
 * behavior lives in one place.
 *
 * DECISION (open question "full answer or truncated prefix"): the question plus a CLEANED,
 * TRUNCATED excerpt of the answer (research N2). The full answer adds latency (tens of KB,
 * non-Latin scripts tokenize 2-3x worse) without improving a 2-4 word name; code-heavy
 * answers would bias the language toward English, hence the cleaning.
 *
 * Timing: naming runs AFTER the answer completes (sequentially; it used to run in parallel
 * with the answer and saw only the question). The question is in status `naming` meanwhile.
 */

/** `Agent.name` input. CHANGED: `answer` added (the full final answer text). */
export interface NameInput {
  /** User text, or `Attached files: <name1>, <name2>` for a files-only message (unchanged). */
  question: string;
  /** NEW. Full answer text; the agent implementation builds the excerpt itself. */
  answer: string;
  model: string;
  /** Aborted on cancel/shutdown and after NAMING_TIMEOUT_MS (./lifecycle.ts). */
  signal: AbortSignal;
}

/** Question part of the naming prompt: first N graphemes (grapheme-safe cut). */
export const NAMING_QUESTION_MAX_GRAPHEMES = 500;
/** Answer excerpt cap, cut at a word boundary (grapheme-safe). */
export const NAMING_EXCERPT_MAX_CHARS = 1_500;

/**
 * `namingExcerpt(answer)` — cleaning, in this order:
 *   1. remove fenced blocks (``` and ~~~, any info string: code, mermaid, csv, tsv, …);
 *   2. remove footnote definition lines `[^x]: …` and footnote refs `[^x]`;
 *   3. remove images `![alt](url)` entirely; links `[text](url)` → `text`;
 *   4. remove bare URLs, inline code spans and HTML tags;
 *   5. collapse whitespace; cut to NAMING_EXCERPT_MAX_CHARS at a word boundary.
 * Empty result (code-only answer) → the `<answer>` block contains `(no prose)` and the model
 * follows the question's language.
 */
export type NamingExcerpt = (answer: string) => string;

/**
 * Prompt (wording is the implementer's, semantics fixed; example names are labeled by
 * language so the model does not default to English):
 *
 *   system: You name folders. Output only the name.
 *   user:
 *     Name this question-and-answer exchange for a folder.
 *     - 2 to 4 words, lowercase, joined by hyphens.
 *     - Use the language and script of the answer's prose (ignore code, links and citations).
 *       Do not transliterate or translate.
 *     - Letters and digits only. Reply with the name only.
 *     Examples: English: borrowing-rules. Russian: правила-заимствования. German: regeln-der-ausleihe.
 *
 *     <question>
 *     …question, ≤ NAMING_QUESTION_MAX_GRAPHEMES…
 *     </question>
 *     <answer>
 *     …namingExcerpt(answer)…
 *     </answer>
 *
 * SDK call: `maxTurns: 1`, no tools, isolated options (unchanged).
 * Output: `sanitizeNodeName(reply)` = first line → `toNodeName(…, { maxWords: 4 })`
 * (./node-names.ts). Prompt injection via the answer can at worst produce an odd name.
 * Failure / timeout / empty result → `fallbackNodeName(question)` =
 * `toNodeName(question, { maxWords: 4 })` — now in the question's own script (today a
 * Cyrillic question falls back to `node`).
 */
export type NamingPrompt = never;
