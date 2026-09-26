import { useCallback, useSyncExternalStore } from 'react';
import { afterDelete, afterMove, isSameOrDescendant } from './tree';

/** One side chat: branches from `anchor`; `head` is the latest node it created (null until sent). */
export interface SideChatState {
  anchor: string;
  head: string | null;
}

export interface UrlState {
  tree: string | null;
  node: string;
  /** Open side chat, kept in `?side=<anchor>[&sideNode=<head>]`. */
  side: SideChatState | null;
}

/** `head` must lie strictly inside the anchor's subtree. */
const isValidHead = (head: string, anchor: string) =>
  head !== '' && head !== anchor && isSameOrDescendant(head, anchor);

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  const tree = params.get('tree') || null;
  const node = params.get('node') ?? '';
  // List seam: several side chats would be aligned `side`/`sideNode` pairs; read the first only.
  const anchors = params.getAll('side');
  const heads = params.getAll('sideNode');
  const anchor = anchors[0];
  if (tree === null || anchor === undefined) return { tree, node, side: null };
  const head = heads[0];
  return {
    tree,
    node,
    side: { anchor, head: head !== undefined && isValidHead(head, anchor) ? head : null },
  };
}

export function writeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.tree) params.set('tree', state.tree);
  if (state.tree && state.node) params.set('node', state.node);
  if (state.tree && state.side) {
    params.set('side', state.side.anchor);
    if (state.side.head !== null) params.set('sideNode', state.side.head);
  }
  const query = params.toString().replace(/%2F/g, '/');
  return query ? `?${query}` : '';
}

/** Apply a partial update; switching trees resets `node` and `side` unless they are given. */
export function mergeUrlState(current: UrlState, next: Partial<UrlState>): UrlState {
  const merged: UrlState = { ...current, ...next };
  const treeChanged = next.tree !== undefined && next.tree !== current.tree;
  if (treeChanged && next.node === undefined) merged.node = '';
  if (treeChanged && next.side === undefined) merged.side = null;
  return merged;
}

/** Open a fresh side chat on `anchor`. */
export function openSide(_state: UrlState, anchor: string): Partial<UrlState> {
  return { side: { anchor, head: null } };
}

/**
 * Track the node a side send just created. Returns `{}` when the side chat was closed or
 * re-anchored meanwhile (a stale completion).
 */
export function advanceSide(state: UrlState, nodeId: string, anchor?: string): Partial<UrlState> {
  const side = state.side;
  if (!side) return {};
  if (anchor !== undefined && side.anchor !== anchor) return {};
  if (!isValidHead(nodeId, side.anchor)) return {};
  return { side: { ...side, head: nodeId } };
}

/** Focus the side head in the main chat and close the side chat; null before the first send. */
export function promoteSide(state: UrlState): Partial<UrlState> | null {
  const head = state.side?.head;
  if (head === null || head === undefined) return null;
  return { node: head, side: null };
}

export function closeSide(): Partial<UrlState> {
  return { side: null };
}

/** New side ids after a move; the same object when nothing changed. */
export function remapSideAfterMove(
  side: SideChatState,
  moved: Record<string, string>,
): SideChatState {
  const anchor = afterMove(side.anchor, moved);
  let head = side.head === null ? null : afterMove(side.head, moved);
  if (head !== null && !isValidHead(head, anchor)) head = null;
  return anchor === side.anchor && head === side.head ? side : { anchor, head };
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

/** Selected tree, node and side chat, kept in the query string so reloads keep them. */
export function useUrlState(): [UrlState, (next: Partial<UrlState>, replace?: boolean) => void] {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const state = readUrlState(search);
  const navigate = useCallback((next: Partial<UrlState>, replace = false) => {
    const merged = mergeUrlState(readUrlState(window.location.search), next);
    const url = `${window.location.pathname}${writeUrlState(merged)}`;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);
  return [state, navigate];
}
