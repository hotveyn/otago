import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { afterDelete, afterMove, isSameOrDescendant } from './tree';

/**
 * One side chat: branches from `anchor`; `head` is the latest node it created (null until
 * sent); `question` is the in-flight question the panel shows (`?sideQ=`), if any.
 */
export interface SideChatState {
  anchor: string;
  head: string | null;
  question: string | null;
}

export interface UrlState {
  tree: string | null;
  node: string;
  /** In-flight question shown in the main chat (`?q=`); its parent is `node`. */
  question: string | null;
  /** Foreground side chat, kept in `?side=<anchor>[&sideNode=<head>][&sideQ=<id>]`. */
  side: SideChatState | null;
}

/** `head` must lie strictly inside the anchor's subtree. */
export const isValidHead = (head: string, anchor: string) =>
  head !== '' && head !== anchor && isSameOrDescendant(head, anchor);

/** Ids from the URL may be NFD (e.g. a pasted macOS path); the server sends NFC. */
const nfc = (id: string) => id.normalize('NFC');

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const tree = params.get('tree') || null;
  const node = nfc(params.get('node') ?? '');
  const question = tree === null ? null : params.get('q') || null;
  // List seam: several side chats would be aligned `side`/`sideNode`/`sideQ` entries; read the
  // first only.
  const anchors = params.getAll('side');
  const heads = params.getAll('sideNode');
  const questions = params.getAll('sideQ');
  const rawAnchor = anchors[0];
  if (tree === null || rawAnchor === undefined) return { tree, node, question, side: null };
  const anchor = nfc(rawAnchor);
  const rawHead = heads[0];
  const head = rawHead === undefined ? undefined : nfc(rawHead);
  return {
    tree,
    node,
    question,
    side: {
      anchor,
      head: head !== undefined && isValidHead(head, anchor) ? head : null,
      question: questions[0] || null,
    },
  };
}

export function writeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.tree) params.set('tree', state.tree);
  if (state.tree && state.node) params.set('node', state.node);
  if (state.tree && state.question) params.set('q', state.question);
  if (state.tree && state.side) {
    params.set('side', state.side.anchor);
    if (state.side.head !== null) params.set('sideNode', state.side.head);
    if (state.side.question) params.set('sideQ', state.side.question);
  }
  const query = params.toString().replace(/%2F/g, '/');
  return query ? `?${query}` : '';
}

/**
 * Apply a partial update. Switching trees resets `node`, `question` and `side` unless they are
 * given; changing `node` resets `question` unless it is given (selecting a node leaves the
 * in-flight focus).
 */
export function mergeUrlState(current: UrlState, next: Partial<UrlState>): UrlState {
  const merged: UrlState = { ...current, ...next };
  const treeChanged = next.tree !== undefined && next.tree !== current.tree;
  if (treeChanged && next.node === undefined) merged.node = '';
  if (treeChanged && next.side === undefined) merged.side = null;
  if (treeChanged && next.question === undefined) merged.question = null;
  const nodeChanged = merged.node !== current.node;
  if (nodeChanged && next.question === undefined) merged.question = null;
  return merged;
}

/** Open a fresh side chat on `anchor`. */
export function openSide(_state: UrlState, anchor: string): Partial<UrlState> {
  return { side: { anchor, head: null, question: null } };
}

/**
 * Focus the side head in the main chat and close the side chat; null before the first send
 * and while the side chat shows an in-flight question.
 */
export function promoteSide(state: UrlState): Partial<UrlState> | null {
  const side = state.side;
  if (!side || side.head === null || side.question !== null) return null;
  return { node: side.head, question: null, side: null };
}

export function closeSide(): Partial<UrlState> {
  return { side: null };
}

/**
 * New side ids after a move (`moved`) or a node rename (`renamed`, full map); the same object
 * when nothing changed. The question id never changes (the server remaps its parent).
 */
export function remapSideAfterMove(
  side: SideChatState,
  moved: Record<string, string>,
): SideChatState {
  const anchor = afterMove(side.anchor, moved);
  let head = side.head === null ? null : afterMove(side.head, moved);
  if (head !== null && !isValidHead(head, anchor)) head = null;
  return anchor === side.anchor && head === side.head
    ? side
    : { anchor, head, question: side.question };
}

/**
 * URL after the tree `oldTreeId` was renamed to `newTreeId`: same node, question and side
 * chat (node ids are tree-relative). `{}` when another tree is shown by now.
 */
export function followTreeRename(
  state: UrlState,
  oldTreeId: string,
  newTreeId: string,
): Partial<UrlState> {
  if (state.tree !== oldTreeId) return {};
  return { tree: newTreeId, node: state.node, question: state.question, side: state.side };
}

/**
 * Side ids after deleting `ids`; the same object when nothing changed. A deleted anchor is
 * kept, so the panel shows its node-missing state; a deleted head falls back to its nearest
 * surviving ancestor inside the side branch, or to unsent.
 */
export function remapSideAfterDelete(side: SideChatState, ids: string[]): SideChatState {
  if (afterDelete(side.anchor, ids) !== side.anchor) return side;
  if (side.head === null) return side;
  const survivor = afterDelete(side.head, ids);
  const head = isValidHead(survivor, side.anchor) ? survivor : null;
  return head === side.head ? side : { ...side, head };
}

const subscribe = (onChange: () => void) => {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
};

export type Navigate = (next: Partial<UrlState>, replace?: boolean) => void;

/** Selected tree, node, focus and side chat, kept in the query string so reloads keep them. */
export function useUrlState(): [UrlState, Navigate] {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const state = useMemo(() => readUrlState(search), [search]);
  const navigate = useCallback<Navigate>((next, replace = false) => {
    const merged = mergeUrlState(readUrlState(window.location.search), next);
    const url = `${window.location.pathname}${writeUrlState(merged)}`;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);
  return [state, navigate];
}
