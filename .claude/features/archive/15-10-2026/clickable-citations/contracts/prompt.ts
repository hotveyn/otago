/**
 * CONTRACT SPEC (planning artifact) — feature `clickable-citations`. Owner: server.
 * Server-internal: what `SYSTEM_RULES` (`server/src/agent/prompt.ts`) must tell the agent so
 * that every footnote it writes parses with ./citations.ts. The exact wording is the server
 * plan's; these are the requirements and the invariant the server test checks.
 */

/**
 * Requirements on the system prompt (rule 2 "Cite…" and the "User files" bullet):
 *  R1  Text sources (`.md`, `.txt`, extracted e-book text `<book>.md`) are cited with LINE
 *      numbers: `sources/<file>:<start>-<end>`.
 *  R2  PDFs are cited with PAGE numbers: `sources/<file>.pdf:<first page>-<last page>` (the
 *      page numbers the `Read` tool shows). The prompt says explicitly that PDFs have no line
 *      numbers.
 *  R3  User files follow the same rule: `files/<name>:<start>-<end>` for the current message,
 *      `<node-id>/files/<name>:<start>-<end>` for earlier messages; pages for `.pdf`, lines
 *      otherwise. (Existing phrases `files/<name>` and `<node-id>/files/` stay verbatim: the
 *      current tests assert them.)
 *  R4  The reference comes FIRST in the footnote; any commentary comes after it, on the same
 *      line (e.g. ` (chapter summary)`). Nothing before the reference.
 *  R5  One reference per footnote (two sources = two footnotes).
 *  R6  The range is digits only (`:35-37`, `:35`), no `p.`/`pages`/`lines` words, no spaces
 *      inside the range; the file name is used exactly as listed/on disk (no renaming, no
 *      path prefix other than `sources/`, `files/`, `<node-id>/files/`).
 *  R7  URLs stay as today (a bare URL footnote).
 *  R8  The rule's example shows BOTH a text citation and a PDF citation with a comment, e.g.
 *        [^1]: sources/the-book-ch4.md:120-134
 *        [^2]: sources/the-book.pdf:35-37 (chapter summary)
 *      Every example footnote line in SYSTEM_RULES MUST parse per ./citations.ts with the ref
 *      first (PROMPT_EXAMPLE_FOOTNOTE_RE below; the server test enforces this so the prompt
 *      can never drift from the grammar).
 *  R9  Everything else in SYSTEM_RULES is unchanged (rules 1, 3-6, rich output, trash/staging
 *      lines). The naming prompt is untouched (footnotes are already stripped from the naming
 *      excerpt, and comments after refs are stripped with the whole definition line).
 */
export type PromptRequirements = never;

/**
 * Invariant checked by `server/test/agent.test.ts`: each `[^k]: …` line of SYSTEM_RULES, with
 * leading whitespace removed, matches this (a `sources/` or `files/` ref per ./citations.ts,
 * followed by nothing or by whitespace + comment). Written here in its simplest form; the
 * test may copy it verbatim (the server never imports the web parser).
 */
export const PROMPT_EXAMPLE_FOOTNOTE_RE =
  /^\[\^[^\]\s]+\]: (?:(?:[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}-]*\/)*(?:sources|files)\/[^\s:]+(?: [^:]+?)?\.(?:md|txt|pdf):\d+(?:-\d+)?|https?:\/\/\S+)(?:\s+\S.*)?$/u;

/** Phrases the server test asserts are present in SYSTEM_RULES (in addition to the current ones). */
export const PROMPT_REQUIRED_PHRASES = [
  'sources/<file>:<start>-<end>',
  'sources/<file>.pdf:<first page>-<last page>',
  'page numbers',
  'line numbers',
  'files/<name>:<start>-<end>',
  '<node-id>/files/<name>:<start>-<end>',
] as const;
