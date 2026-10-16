/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * Server-internal: what the answering agent is told. Clients never see this; the demo's block
 * simulator reproduces the observable output (map answers with all parts + one whole item).
 *
 * UNCHANGED: `Agent` / `AskInput` (`openSuggestions: string[]`), `buildUserPrompt`, the
 * `<open-suggestions>` block, the runner lifecycle (filter → split → finalize → createNode),
 * the `ask` CLI (it prints the raw block items and the finalized items as JSON, so the prefix
 * and `kind` show up there without code changes).
 */

/**
 * SYSTEM_RULES "Big topics" section — REPLACED. Semantics fixed, final wording in the server
 * plan (`projects/server/plan.md`). Requirements:
 *  - split when the question covers more than one answer can explain in full detail;
 *  - a split answer is ONLY the map: a short statement that the topic is big, then one line per
 *    part in learning order; it explains no part, gives no examples, asks no
 *    check-your-understanding question (overrides rule "Teach" for map answers); it may cite
 *    where each part lies in the sources;
 *  - block: one request per part, THE FIRST PART INCLUDED, in map order, each understandable on
 *    its own, in the answer's language;
 *  - then exactly one last item `- ${WHOLE_ITEM_PREFIX} <request>`: the learner asks for the whole
 *    topic in one answer without splitting, in the answer's language; only in a map's block,
 *    never otherwise, never copied from <open-suggestions>;
 *  - answering a part: explain it in full; keep uncovered parts from <open-suggestions> word for
 *    word (UNCHANGED);
 *  - a part still too big is split again the same way (its own map, its own whole item);
 *  - a short overview or an explicit "everything in one answer" request is answered in one
 *    message without splitting (UNCHANGED; this is what makes the "whole" click work);
 *  - NO digits in the section (existing test rule), so no "two or more parts" wording.
 * "Next questions" section: "the remaining parts of a split topic" → "the parts of a split
 * topic" (all parts on the map, the remaining ones on a part answer).
 */
export type BigTopicsRules = never;
