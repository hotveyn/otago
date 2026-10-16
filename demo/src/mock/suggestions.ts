/**
 * The demo's stand-in for the answering agent's suggestion block (contract
 * `.claude/features/inline-suggestions/contracts/agent.ts`, prompt section "Next questions",
 * and `.claude/features/topic-split-v2/contracts/agent.ts`, "Big topics"): which item texts the
 * model would write after its answer. A big topic becomes a map answer (`mapAnswer`) whose block
 * lists every part plus one "explain it whole" item (`wholeItem`). `questions.ts` appends the
 * texts with `suggestionBlock`; the server's pure modules do the rest (filter, split,
 * finalization). Pure: no I/O, no timers, deterministic for a given `random`.
 */

import { wholeItem } from '../../../server/src/storage/suggestion-block';
import type { StoredSuggestion } from '../../../server/src/storage/suggestions';
import { collapseWhitespace, firstLine, truncateGraphemes } from '../../../server/src/text';

export interface SimulatedBlockInput {
  treeId: string;
  parentId: string;
  /** The question text as sent (`''` for a files-only message). */
  question: string;
  /** Texts of the parent's open suggestions, in order (the server's `<open-suggestions>`). */
  openSuggestions: readonly string[];
  attempt: number;
}

/** Item texts of the block to append; `undefined` = no block; `[]` = the marker line alone. */
export type BlockSimulator = (input: SimulatedBlockInput) => readonly string[] | undefined;

/** A question too big for one answer: it is split into a map. */
const BIG_TOPIC_RE = /\b(plan|steps?|chapters?|roadmap|outline)\b/i;
/** Our own part texts: asking one does not split again; group 1 = the topic for templates. */
const PART_RE = /^Explain (part \d+ of .+)$/;
/** Our own "explain it whole" text; group 1 = the topic. */
const WHOLE_TEXT_RE = /^Explain all of (.+) in one answer, without splitting it$/;
/** An explicit "everything in one answer" request: never split (checked before BIG_TOPIC_RE). */
const WHOLE_REQUEST_RE = /\b(?:in one answer|without splitting|all at once)\b/i;
/** Parts of a simulated map (deterministic, no random draw). */
export const SPLIT_PARTS = 3;
const PLAN_REQUEST_RE =
  /^(?:please\s+)?(?:make|give|write|create|draft)(?:\s+me)?\s+(?:an?\s+)?(?:plan|roadmap|outline)\s+(?:for|of|on|about)\s+/i;
const TOPIC_MAX_WORDS = 6;
const TOPIC_MAX_GRAPHEMES = 60;
const OWN_TEMPLATES: ReadonlyArray<(topic: string) => string> = [
  (topic) => `Can you show a bigger example of ${topic}?`,
  (topic) => `What are common mistakes with ${topic}?`,
  (topic) => `Give me a short exercise on ${topic}`,
  (topic) => `How does ${topic} work under the hood?`,
];
/** Below this draw: no block (the common case; open suggestions stay visible by inheritance). */
const NO_BLOCK_BELOW = 0.4;
/** Below this draw: the marker line alone when there are open suggestions (drops them all). */
const EMPTY_BELOW = 0.5;
/** Chance to keep each open suggestion verbatim in a block with own items. */
const KEEP_PROBABILITY = 0.7;

/** The request for part `n` of a split topic. */
export function partText(topic: string, n: number): string {
  return `Explain part ${n} of ${topic}`;
}

/** The "explain it whole" request of a split topic. */
export function wholeText(topic: string): string {
  return `Explain all of ${topic} in one answer, without splitting it`;
}

/**
 * The parts of a map answer: the own regular items of a finalized list that kept its `whole`
 * item (the server's `MIN_SPLIT_PARTS` rule decided that); `undefined` = not a map.
 */
export function splitParts(finalized: readonly StoredSuggestion[]): string[] | undefined {
  if (!finalized.some((item) => item.kind === 'whole')) return undefined;
  return finalized
    .filter((item) => item.up === 0 && item.kind === undefined)
    .map((item) => item.text);
}

const partLabel = (part: string) => {
  const label = part.replace(/^Explain /, '');
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** The map-only answer of a split topic: no explanation, no example, no exercise. */
export function mapAnswer(parts: readonly string[]): string {
  const list = parts.map((part, i) => `${i + 1}. ${partLabel(part)}`).join('\n');
  return [
    'This topic is too big for one answer, so here is a map of its parts. Learn them in this order.',
    list,
    'Pick a part below to start, or ask for all of it in one answer.',
  ].join('\n\n');
}

/** What a question is about, for the template texts. */
export function suggestionTopic(question: string): string {
  const line = collapseWhitespace(firstLine(question));
  if (!line || line.startsWith('Attached files:')) return 'these files';
  const own = PART_RE.exec(line)?.[1] ?? WHOLE_TEXT_RE.exec(line)?.[1];
  const text = (own ?? line).replace(PLAN_REQUEST_RE, '').replace(/[?.!]+$/, '');
  const words = text.split(' ').slice(0, TOPIC_MAX_WORDS).join(' ');
  return truncateGraphemes(words, TOPIC_MAX_GRAPHEMES).trim() || 'this';
}

/**
 * The default block "model". A part question keeps exactly the open suggestions (the uncovered
 * parts), or writes no block without any. A big-topic question (not asked "in one answer") is
 * split: every part, the first included, then every open suggestion, then one whole item.
 * Otherwise often no block, sometimes the marker alone (drops the open suggestions), else 1–2
 * template questions plus most open suggestions verbatim (never a whole item).
 */
export function simulateSuggestionBlock(random: () => number): BlockSimulator {
  return ({ question, openSuggestions }) => {
    const topic = suggestionTopic(question);
    if (PART_RE.test(collapseWhitespace(firstLine(question)))) {
      return openSuggestions.length > 0 ? [...openSuggestions] : undefined;
    }
    if (BIG_TOPIC_RE.test(question) && !WHOLE_REQUEST_RE.test(question)) {
      const parts = Array.from({ length: SPLIT_PARTS }, (_, i) => partText(topic, i + 1));
      return [...parts, ...openSuggestions, wholeItem(wholeText(topic))];
    }
    const r = random();
    if (r < NO_BLOCK_BELOW) return undefined;
    if (r < EMPTY_BELOW) return openSuggestions.length > 0 ? [] : undefined;
    const count = 1 + Math.floor(random() * 2);
    const start = Math.floor(random() * OWN_TEMPLATES.length);
    const own: string[] = [];
    for (let i = 0; i < count; i++) {
      const template = OWN_TEMPLATES[(start + i) % OWN_TEMPLATES.length];
      if (template) own.push(template(topic));
    }
    const kept = openSuggestions.filter(() => random() < KEEP_PROBABILITY);
    return [...own, ...kept];
  };
}
