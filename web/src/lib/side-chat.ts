import type { ChainNode } from '../api/types';
import type { SideChatState } from './url-state';

/** The side conversation: chain nodes strictly after the anchor ([] when inconsistent). */
export function sideThread(chain: ChainNode[], anchor: string): ChainNode[] {
  if (anchor === '') return chain;
  const index = chain.findIndex((node) => node.id === anchor);
  return index === -1 ? [] : chain.slice(index + 1);
}

/** Where the next side message goes. */
export const sideParent = (side: SideChatState): string => side.head ?? side.anchor;

/** "Open in main chat" needs a created node and no running stream. */
export const canPromote = (side: SideChatState, streaming: boolean): boolean =>
  side.head !== null && !streaming;
