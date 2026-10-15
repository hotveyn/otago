import { useCallback, useMemo } from 'react';
import { useNodeSuggestions } from '../../api/queries';
import type { QuestionContext, Suggestion } from '../../api/types';
import { useHydrated, useQuestionStore, useStoreSelector } from '../../lib/question-store';
import { shallowArrayEqual } from '../../lib/questions';
import { askSuggestion, inFlightSuggestionKeys, visibleSuggestions } from '../../lib/suggestions';
import type { ModelChoice } from './Composer';

export interface SuggestionsOptions {
  treeId: string;
  /** The panel's focused saved node (`null` = none; `''` is treated as none). */
  nodeId: string | null;
  context: QuestionContext;
  stashKey: string;
  /** The panel's model choice (`useComposer().models`). */
  models: ModelChoice;
  /** Panel gating: no in-flight view, the chain shows `nodeId` last, no chain error. */
  show: boolean;
}

export interface Suggestions {
  items: Suggestion[];
  ask: (suggestion: Suggestion) => void;
}

const EMPTY: Suggestion[] = [];
const NO_TARGETS: string[] = [];

/**
 * Suggested questions of one chat panel: the node's list (fetched, generated lazily once when
 * missing) minus the questions already in flight, shown only once the store is hydrated (a
 * question from another tab or before a reload would otherwise be asked twice).
 */
export function useSuggestions({
  treeId,
  nodeId,
  context,
  stashKey,
  models,
  show,
}: SuggestionsOptions): Suggestions {
  const store = useQuestionStore();
  const hydrated = useHydrated();
  const list = useNodeSuggestions(treeId, nodeId === '' ? null : nodeId);

  const targets = useMemo(
    () => (list ? [...new Set(list.map((item) => item.target))] : NO_TARGETS),
    [list],
  );
  const targetsKey = targets.join('\n');
  // `targets` changes with `targetsKey`; chunks never change the result.
  const inFlight = useStoreSelector(
    (state) => inFlightSuggestionKeys(state, treeId, targets),
    shallowArrayEqual,
    [treeId, targetsKey],
  );

  const anchor = context.kind === 'side' ? context.anchor : null;
  const items = useMemo(() => {
    if (!show || !hydrated || !list) return EMPTY;
    const visible = visibleSuggestions(list, inFlight, { anchor });
    return visible.length === 0 ? EMPTY : visible;
  }, [show, hydrated, list, inFlight, anchor]);

  const { model, namingModel } = models;
  const ask = useCallback(
    (suggestion: Suggestion) => {
      askSuggestion(store, { tree: treeId, context, stashKey, suggestion, model, namingModel });
    },
    [store, treeId, context, stashKey, model, namingModel],
  );

  return { items, ask };
}
