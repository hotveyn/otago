/**
 * URL focus rules for in-flight questions (`?q=` main chat, `?sideQ=` foreground aside). PURE;
 * every patch is idempotent once applied (applying it makes the function return `null`).
 */
import type { QuestionContext, QuestionInfo } from '../api/types';
import type { QuestionsState } from './questions';
import { sideParent } from './side-chat';
import { isSameOrDescendant } from './tree';
import { isValidHead, openSide, type SideChatState, type UrlState } from './url-state';

const headFor = (parentId: string, anchor: string): string | null =>
  parentId === anchor ? null : parentId;

/**
 * Keep the focused questions and the URL consistent with the store:
 *  - unknown after hydration, other tree, or (aside) not a side question → drop the focus;
 *  - done and acked → follow to the created node;
 *  - parent remapped by a move/rename → follow it.
 * Before the first snapshot only already-known ids are reconciled.
 */
export function reconcileFocus(url: UrlState, state: QuestionsState): Partial<UrlState> | null {
  const patch: Partial<UrlState> = {};

  const main = url.question;
  if (main !== null) {
    const info = state.questions[main];
    if (!info) {
      if (state.hydrated) patch.question = null;
    } else if (info.tree !== url.tree) {
      patch.question = null;
    } else if (info.status === 'done' && state.acked[main]) {
      patch.node = info.nodeId;
      patch.question = null;
    } else if (url.node !== info.parentId) {
      patch.node = info.parentId;
      patch.question = main;
    }
  }

  const side = url.side;
  if (side && side.question !== null) {
    const info = state.questions[side.question];
    const drop = (): SideChatState => ({ ...side, question: null });
    if (!info) {
      if (state.hydrated) patch.side = drop();
    } else if (info.tree !== url.tree || info.context.kind !== 'side') {
      patch.side = drop();
    } else if (info.status === 'done' && state.acked[info.id]) {
      patch.side = {
        anchor: side.anchor,
        head: isValidHead(info.nodeId, side.anchor) ? info.nodeId : side.head,
        question: null,
      };
    } else {
      const anchor = info.context.anchor;
      const head = headFor(info.parentId, anchor);
      if (side.anchor !== anchor || side.head !== head)
        patch.side = { anchor, head, question: info.id };
    }
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

/**
 * A 202 arrived (checked against the LIVE URL): focus the new question in the panel that sent
 * it, but only while that panel still targets the same parent and shows no other question.
 * Otherwise `null`: the question only appears in the graph.
 */
export function acceptedFocus(url: UrlState, question: QuestionInfo): Partial<UrlState> | null {
  if (url.tree !== question.tree) return null;
  const context = question.context;
  if (context.kind === 'main') {
    if (url.node !== question.parentId || url.question !== null) return null;
    return { question: question.id };
  }
  const side = url.side;
  if (!side || side.anchor !== context.anchor || side.question !== null) return null;
  if (sideParent(side) !== question.parentId) return null;
  return { side: { ...side, question: question.id } };
}

/**
 * A send to `parentId` from the panel of `context` that should be followed there (the "explain
 * it whole" suggestion): the patch that makes that panel target `parentId` with no focused
 * question, so its outbox box shows at once and the 202 focus (`acceptedFocus`) applies.
 * `null` = nothing to change, or no such panel (another aside, or a parent above the aside's
 * anchor, which would break its context).
 */
export function sendFocusTarget(
  url: UrlState,
  context: QuestionContext,
  parentId: string,
): Partial<UrlState> | null {
  if (context.kind === 'main') {
    if (url.node === parentId && url.question === null) return null;
    return { node: parentId, question: null };
  }
  const side = url.side;
  const anchor = context.anchor;
  if (!side || side.anchor !== anchor || !isSameOrDescendant(parentId, anchor)) return null;
  const head = headFor(parentId, anchor);
  if (side.head === head && side.question === null) return null;
  return { side: { anchor, head, question: null } };
}

function targetOf(
  tree: string,
  parentId: string,
  context: QuestionContext,
  question: string | null,
): Partial<UrlState> {
  if (context.kind === 'main') return { tree, node: parentId, question };
  return {
    tree,
    side: { anchor: context.anchor, head: headFor(parentId, context.anchor), question },
  };
}

/**
 * Where clicking a pending box (by its key, or a question id) leads: the main chat at the
 * parent, or the aside on its anchor; that panel's previous content goes to the background.
 */
export function openPendingTarget(key: string, state: QuestionsState): Partial<UrlState> | null {
  const entry = state.outbox[key];
  if (entry) return targetOf(entry.tree, entry.parentId, entry.context, null);
  const id = Object.hasOwn(state.questions, key)
    ? key
    : Object.keys(state.localKeys).find((questionId) => state.localKeys[questionId] === key);
  const info = id === undefined ? undefined : state.questions[id];
  if (!info) return null;
  return targetOf(info.tree, info.parentId, info.context, info.id);
}

/**
 * "Ask aside" from the main chat on `anchor` (the node the text was selected in; the main chain
 * shows ancestors of `url.node` too): `'disabled'` while the main chat shows a question (it has
 * no node to anchor on); `null` to reuse the open aside on the same anchor with no question;
 * otherwise a new aside (the previous one keeps answering in the background).
 */
export function askAsideTarget(
  url: UrlState,
  anchor: string = url.node,
): Partial<UrlState> | null | 'disabled' {
  if (url.question !== null) return 'disabled';
  if (url.side && url.side.anchor === anchor && url.side.question === null) return null;
  return openSide(url, anchor);
}

/** Which panel of this tab shows question `id`. */
export function focusedIn(url: UrlState, id: string): 'main' | 'side' | null {
  if (url.question === id) return 'main';
  if (url.side?.question === id) return 'side';
  return null;
}
