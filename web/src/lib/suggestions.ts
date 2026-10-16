/**
 * Suggested follow-up questions of a saved node (contracts
 * `.claude/features/inline-suggestions/contracts/` and, for the "explain it whole" item,
 * `.claude/features/topic-split-v2/contracts/`): the client-side visibility rules on top of the
 * server's resolved list, and the click. Pure, no React.
 */
import type { QuestionContext, Suggestion } from '../api/types';
import type { QuestionStore } from './question-store';
import type { QuestionsState } from './questions';
import { truncateGraphemes } from './text';
import { isSameOrDescendant, nameOf } from './tree';

/** Button label cap; the full text goes in the tooltip and is what gets sent. */
export const SUGGESTION_LABEL_GRAPHEMES = 120;

/** The one text equality of the contract (web copy): trimmed, NFC, case-sensitive. */
export const suggestionKey = (text: string): string => text.trim().normalize('NFC');

const entryKey = (target: string, text: string): string => `${target}\0${suggestionKey(text)}`;

/** The "explain it whole" item of a map node. */
export const isWholeSuggestion = (s: Suggestion): boolean => s.kind === 'whole';

/** A kind this client renders: regular (no `kind`) or `whole`. Unknown kinds are not shown. */
export function isKnownSuggestion(s: Suggestion): boolean {
  const kind = s.kind as string | undefined;
  return kind === undefined || kind === 'whole';
}

/** Items whose click moves the clicked panel to their target (only `whole` for now). */
export const suggestionMovesFocus = (s: Suggestion): boolean => isWholeSuggestion(s);

/**
 * Sorted unique `${parentId}\0${key}` of the store entries that hide a suggestion under one
 * of `targets` in `tree`: live sends of this tab (not the "Not sent" ones, whose text went
 * back to the composer) and questions of every status, except done ones whose node is in the
 * refetched tree (acked; the server's "used" filter covers them from then on). Stable
 * strings, so `shallowArrayEqual` works as the selector equality.
 */
export function inFlightSuggestionKeys(
  state: QuestionsState,
  tree: string,
  targets: readonly string[],
): string[] {
  if (targets.length === 0) return [];
  const wanted = new Set(targets);
  const found = new Set<string>();
  for (const entry of Object.values(state.outbox)) {
    if (entry.tree !== tree || entry.error !== null || !wanted.has(entry.parentId)) continue;
    found.add(entryKey(entry.parentId, entry.text));
  }
  for (const info of Object.values(state.questions)) {
    if (info.tree !== tree || !wanted.has(info.parentId)) continue;
    if (info.status === 'done' && state.acked[info.id]) continue;
    found.add(entryKey(info.parentId, info.text));
  }
  return [...found].sort();
}

/**
 * What a panel shows, in order:
 *  1. drop items with an unknown `kind`;
 *  2. drop items with an in-flight entry under their target (`inFlight` from
 *     `inFlightSuggestionKeys`);
 *  3. side panel (`anchor !== null`): drop items whose target lies above the anchor (a send
 *     there would break the aside's context);
 *  4. regular items, dedupe by key: an own item (`up === 0`) beats an inherited one wherever it
 *     appears, otherwise the first one wins; the server's order (own first) is kept;
 *  5. `whole` items take no part in step 4 (never dropped as inherited, never hide anything):
 *     the first one is kept and placed last.
 * No cap: every remaining item is shown. A list that came through the server's ancestor
 * fallback (all items `up > 0`) goes through the same steps.
 */
export function visibleSuggestions(
  list: readonly Suggestion[],
  inFlight: readonly string[],
  opts: { anchor: string | null },
): Suggestion[] {
  const hidden = new Set(inFlight);
  const { anchor } = opts;
  const kept = list.filter(
    (item) =>
      isKnownSuggestion(item) &&
      !hidden.has(entryKey(item.target, item.text)) &&
      (anchor === null || isSameOrDescendant(item.target, anchor)),
  );
  const regular = kept.filter((item) => !isWholeSuggestion(item));
  const whole = kept.find(isWholeSuggestion);
  const ownKeys = new Set(
    regular.filter((item) => item.up === 0).map((item) => suggestionKey(item.text)),
  );
  const seen = new Set<string>();
  const result: Suggestion[] = [];
  for (const item of regular) {
    const key = suggestionKey(item.text);
    if (seen.has(key) || (item.up !== 0 && ownKeys.has(key))) continue;
    seen.add(key);
    result.push(item);
  }
  if (whole) result.push(whole);
  return result;
}

/** Button text, cut by graphemes. */
export const suggestionLabel = (text: string): string =>
  truncateGraphemes(text, SUGGESTION_LABEL_GRAPHEMES);

/**
 * Source tag of an inherited item (the target's display name); `null` for own items and for
 * items with a `kind` (a `whole` item is not inherited).
 */
export const suggestionSource = (s: Suggestion): string | null =>
  s.kind !== undefined || s.up === 0 ? null : nameOf(s.target);

/** Synchronous double-click guard: pass the CURRENT state (`store.getState()`). */
export function hasInFlightSuggestion(state: QuestionsState, tree: string, s: Suggestion): boolean {
  return inFlightSuggestionKeys(state, tree, [s.target]).includes(entryKey(s.target, s.text));
}

export interface AskSuggestionInput {
  tree: string;
  /** The panel's context; the side panel only shows targets at or below its anchor. */
  context: QuestionContext;
  /** Required by `AskInput`; never written (see the claim below). */
  stashKey: string;
  suggestion: Suggestion;
  model: string | null;
  namingModel: string | null;
  /**
   * The panel's move to `parentId`; called for items that move focus
   * (`suggestionMovesFocus`), after the send is queued and published.
   */
  moveFocus?: (parentId: string) => void;
}

/**
 * Click: send the suggestion as a plain question under its target. Returns the outbox id, or
 * `null` when the same question is already in flight. The outbox gets a no-op claim, so a
 * send that ends before its 202 never puts the text into a draft (`restored: true`); the
 * usual "not sent" notice still shows (`QuestionEffects`). The claim is never released: the
 * store deletes it on the 202 or at the end. For an item that moves focus, the new outbox entry
 * is published (`flush`) before `moveFocus`, so the panel's first render at the target already
 * shows the box; the existing 202 focus (`acceptedFocus`) then takes over.
 */
export function askSuggestion(store: QuestionStore, input: AskSuggestionInput): string | null {
  const { tree, context, stashKey, suggestion, model, namingModel, moveFocus } = input;
  if (hasInFlightSuggestion(store.getState(), tree, suggestion)) return null;
  const id = store.ask({
    tree,
    parentId: suggestion.target,
    context,
    stashKey,
    text: suggestion.text,
    files: [],
    model: model ?? undefined,
    namingModel: namingModel ?? undefined,
  });
  store.claimOutbox(id, () => false);
  if (moveFocus && suggestionMovesFocus(suggestion)) {
    store.flush();
    moveFocus(suggestion.target);
  }
  return id;
}
