import { useCallback, useSyncExternalStore } from 'react';

export interface UrlState {
  tree: string | null;
  node: string;
}

export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);
  return { tree: params.get('tree') || null, node: params.get('node') ?? '' };
}

export function writeUrlState(state: UrlState): string {
  const params = new URLSearchParams();
  if (state.tree) params.set('tree', state.tree);
  if (state.tree && state.node) params.set('node', state.node);
  const query = params.toString().replace(/%2F/g, '/');
  return query ? `?${query}` : '';
}

const subscribe = (onChange: () => void) => {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
};

/** Selected tree and node, kept in `?tree=…&node=…` so reloads keep them. */
export function useUrlState(): [UrlState, (next: Partial<UrlState>, replace?: boolean) => void] {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const state = readUrlState(search);
  const navigate = useCallback((next: Partial<UrlState>, replace = false) => {
    const current = readUrlState(window.location.search);
    const merged: UrlState = { ...current, ...next };
    if (next.tree !== undefined && next.tree !== current.tree && next.node === undefined)
      merged.node = '';
    const url = `${window.location.pathname}${writeUrlState(merged)}`;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, []);
  return [state, navigate];
}
