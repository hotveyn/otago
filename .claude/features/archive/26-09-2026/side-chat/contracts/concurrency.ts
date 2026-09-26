/**
 * CONTRACT SPEC (planning artifact, not runtime code) — feature `side-chat`.
 *
 * Per-tree concurrency semantics (readers–writer lock, in-memory, per server process).
 *
 * Lock modes per tree id:
 *   - SHARED    — held by `POST /trees/:tree/messages` from before it reads the chain until
 *                 the stream ends (done / error / client abort), i.e. for the whole stream
 *                 INCLUDING node creation. Any number of SHARED holders may coexist.
 *   - EXCLUSIVE — held by `POST /trees/:tree/nodes/move` and `POST /trees/:tree/nodes/delete`
 *                 for the duration of the operation. At most one holder, and only when
 *                 there are zero SHARED holders.
 *
 * Policy: REJECT, never queue. Conflicts fail fast with HTTP 409 + `ErrorBody` (./errors.ts).
 *
 * Matrix (row = request arriving, column = what is currently held):
 *
 *                       | nothing | N streams (SHARED) | move/delete (EXCLUSIVE)
 *   message stream      |   ok    |        ok          | 409 tree_busy_structural
 *   move / delete       |   ok    | 409 tree_busy_streaming | 409 tree_busy_structural
 *
 * Locks are per tree: activity in tree A never blocks tree B.
 * Other routes (GET chain/tree/attachments, sources, PATCH tree) take no lock (unchanged).
 *
 * Client consequences (web):
 *   - Main chat and side chat may stream simultaneously in the same tree, even from the
 *     same parent node; both get distinct `done.nodeId`s.
 *   - The graph must treat the tree as busy (disable move/delete/drag) while ANY local
 *     stream is running; if it still sends move/delete (e.g. another tab is streaming) it
 *     gets 409 `tree_busy_streaming`; show `error`, nothing was changed.
 *   - A message POST can get 409 `tree_busy_structural` only in the brief window of a
 *     move/delete; the UI shows `error` in that chat panel and keeps the draft.
 *   - Because streams hold SHARED until the end, the anchor/parent of a running stream can
 *     never be moved or deleted mid-stream. Between turns it can: the next POST then
 *     returns 404 `Node not found: <parentId>` (ids are paths; a move changes the id).
 */

import type { ConflictCode } from './errors';

export type TreeLockMode = 'shared' | 'exclusive';

/** Exact 409 messages (`ErrorBody.error`) and codes. `<tree>` is the tree id. */
export const CONFLICT_MESSAGES: Record<ConflictCode, string> = {
  /** Returned to move/delete while ≥1 message stream is running in the tree. */
  tree_busy_streaming:
    'Tree "<tree>" is busy: an answer is still streaming. Try again when it finishes.',
  /** Returned to any request while a move/delete is running in the tree. */
  tree_busy_structural:
    'Tree "<tree>" is busy: nodes are being moved or deleted. Try again in a moment.',
};

/** Which code a request gets, by requested mode and current holder. */
export interface ConflictRule {
  requested: TreeLockMode;
  heldBy: TreeLockMode;
  code: ConflictCode;
}

export const CONFLICT_RULES: readonly ConflictRule[] = [
  { requested: 'shared', heldBy: 'exclusive', code: 'tree_busy_structural' },
  { requested: 'exclusive', heldBy: 'exclusive', code: 'tree_busy_structural' },
  { requested: 'exclusive', heldBy: 'shared', code: 'tree_busy_streaming' },
];

/** Unchanged response shapes of the exclusive routes, for reference. */
export interface HierarchyNode {
  id: string;
  name: string;
  created: string;
  children: HierarchyNode[];
}

/** `POST /api/trees/:tree/nodes/delete` body `{ ids: string[] }` (1..1000) → 200 */
export interface DeleteNodesResponse {
  nodes: HierarchyNode[];
}

/** `POST /api/trees/:tree/nodes/move` body `{ ids: string[]; targetParentId: string }` → 200 */
export interface MoveNodesResponse {
  /** old id → new id */
  moved: Record<string, string>;
  nodes: HierarchyNode[];
}
