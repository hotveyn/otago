import type { QuestionInfo } from '../api/types';

/** What a chat panel's thread scrolls to when its scroll key changes. */
export interface ScrollAnchor {
  /** The node the panel showed when the anchor was computed. */
  node: string;
  /** The thread's scroll key: changing it scrolls to the start of the current exchange. */
  key: string;
  /** The last question the panel focused (`?q=`), if any. */
  focus: string | null;
}

export const initialScrollAnchor = (node: string, focus: string | null): ScrollAnchor => ({
  node,
  key: node,
  focus,
});

/**
 * Scroll anchor of the main panel for its new `node` / focused question. Switching nodes
 * changes the key (the thread then shows the selected exchange from its start), but following
 * a just-saved answer keeps it: the reader stays where they were in the answer.
 */
export function nextScrollAnchor(
  prev: ScrollAnchor,
  node: string,
  focus: string | null,
  questions: Record<string, QuestionInfo>,
): ScrollAnchor {
  const nextFocus = focus ?? prev.focus;
  if (prev.node === node) return prev.focus === nextFocus ? prev : { ...prev, focus: nextFocus };
  const saved = prev.focus === null ? undefined : questions[prev.focus];
  const followed = saved?.status === 'done' && saved.nodeId === node;
  return { node, key: followed ? prev.key : node, focus: nextFocus };
}
