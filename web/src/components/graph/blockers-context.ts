import { createContext, useContext } from 'react';

/** What opened the blockers dialog: a busy toolbar click, or a 409 of a structural action. */
export interface BlockersRequest {
  tree: string;
  /** The 409 `tree_busy_streaming` (its `details` name the server's blockers). */
  error?: unknown;
  /** The refused action, offered again once nothing blocks it. */
  retry?: { label: string; run: () => void };
}

/** Opens the blockers dialog (provided by `App`; a no-op elsewhere, e.g. in tests). */
export const BlockersContext = createContext<(request: BlockersRequest) => void>(() => undefined);

export const useShowBlockers = () => useContext(BlockersContext);
