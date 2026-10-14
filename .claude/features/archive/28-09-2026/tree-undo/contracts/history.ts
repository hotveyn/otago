/**
 * tree-undo — contract spec: undo history entry model (owned by web, shape fixed here so the
 * server responses above are sufficient to build and invert every entry).
 *
 * PLANNING ARTIFACT. Open discriminated union: new action types (e.g. `rename-node`,
 * `rename-tree` from the `rename-trees-nodes` feature) are added as new members without
 * touching existing ones. Every entry is self-describing (holds its own inverse data), so a
 * future redo would not need a redesign.
 */
import type { NodeId } from './nodes-api';
import type { TrashId } from './trash';

interface HistoryEntryBase<T extends string> {
  type: T;
  /** Client-generated id (e.g. `crypto.randomUUID()`). */
  id: string;
  /** ISO time the action was performed. */
  at: string;
}

/** From `MoveNodesResponse.moved` (identity pairs omitted). */
export interface MoveHistoryEntry extends HistoryEntryBase<'move'> {
  /** Each moved node: current id → where it came from. */
  items: Array<{ currentId: NodeId; oldParentId: NodeId; oldName: string }>;
}

/** From `DeleteNodesResponse.deleted`. */
export interface DeleteHistoryEntry extends HistoryEntryBase<'delete'> {
  items: Array<{ trashId: TrashId; originalId: NodeId }>;
}

/**
 * Future member example (NOT implemented by tree-undo):
 *   interface RenameNodeHistoryEntry extends HistoryEntryBase<'rename-node'> {
 *     currentId: NodeId; oldName: string;
 *   }
 */
export type HistoryEntry = MoveHistoryEntry | DeleteHistoryEntry;

/**
 * Remapping rule after ANY id-changing response (`moved`, `restored`, future `renamed`):
 * for each `old → new`, every NodeId or TrashId `x` in the stack with `x === old` or
 * `x.startsWith(old + '/')` becomes `new + x.slice(old.length)`. Same for `oldParentId`.
 */
export type RemapRule = never;
