/**
 * tree-undo — contract spec: node management HTTP API (delete / move / restore).
 *
 * PLANNING ARTIFACT. Hand-authored spec, not production code, not generated.
 * All routes are under `/api`, take the tree's EXCLUSIVE lock (`locks.withExclusive`), and
 * return the fresh hierarchy. Errors use the shape in `./errors.ts`.
 *
 * Changes vs. today are ADDITIVE: existing fields keep their meaning; old clients keep working.
 */
import type { TrashId } from './trash';

/** Node id = path relative to the tree folder, e.g. `ownership/borrowing-rules`. `""` = root. */
export type NodeId = string;

/** Unchanged existing shape (`server/src/storage/nodes.ts`). Soft-deleted folders never appear. */
export interface HierarchyNode {
  id: NodeId;
  name: string;
  created: string;
  children: HierarchyNode[];
}

// ---------------------------------------------------------------------------
// POST /api/trees/:tree/nodes/delete   (behaviour change: soft delete)
// ---------------------------------------------------------------------------

export interface DeleteNodesRequest {
  /** 1..1000 ids. Duplicates and ids whose ancestor is also selected are dropped (unchanged). */
  ids: NodeId[];
}

export interface DeleteNodesResponse {
  /**
   * NEW. Top-level selected node id → TrashId of its soft-deleted folder.
   * Only top-level ids appear (descendants travel inside their ancestor's trash folder).
   * Key order = processing order.
   */
  deleted: Record<NodeId, TrashId>;
  /** Unchanged. */
  nodes: HierarchyNode[];
}

// ---------------------------------------------------------------------------
// POST /api/trees/:tree/nodes/move   (additive: optional desired names)
// ---------------------------------------------------------------------------

export interface MoveNodesRequest {
  /** 1..1000 ids (unchanged). */
  ids: NodeId[];
  /** Target parent id (unchanged). `""` = tree root. */
  targetParentId: NodeId;
  /**
   * NEW, optional. Selected id → desired folder name at the target (a slug, not reserved for the
   * target level). Used by undo-move to get the ORIGINAL name back when the forward move had to
   * add a `-2` suffix. The name is still claimed uniquely: if taken, `-2`, `-3`, … is appended.
   * Default (absent key): keep the current folder name (today's behaviour).
   * Ignored for nodes already under `targetParentId` (they stay as they are; identity mapping).
   * Keys not in `ids` → 400.
   */
  names?: Record<NodeId, string>;
}

export interface MoveNodesResponse {
  /**
   * Unchanged: top-level selected old id → new id (identity if it already sat under the target).
   * Descendant ids change by prefix rewrite: `old/…` → `new/…` (clients derive them).
   * Old parent for undo = `parentIdOf(oldId)`; old name = last segment of `oldId`.
   */
  moved: Record<NodeId, NodeId>;
  nodes: HierarchyNode[];
}

// ---------------------------------------------------------------------------
// POST /api/trees/:tree/nodes/restore   (NEW)
// ---------------------------------------------------------------------------

export interface RestoreNodesRequest {
  /** 1..1000 TrashIds, as returned by delete (possibly remapped by the client since). */
  trashIds: TrashId[];
}

export interface RestoreNodesResponse {
  /**
   * TrashId → resulting live node id. The node is renamed back in place (same parent) to its
   * original name, or `<name>-2`, `-3`, … if a live sibling took it meanwhile. Descendant ids
   * are `<resultId>/…` with their original relative paths.
   */
  restored: Record<TrashId, NodeId>;
  nodes: HierarchyNode[];
}

/**
 * Restore semantics:
 * - Validate ALL TrashIds before renaming anything: well-formed (400), live parent exists
 *   (404 `parent_not_found`), trash folder exists and contains `node.md` (404 `trash_not_found`).
 *   Any failure → nothing is renamed.
 * - Duplicates are de-duplicated. TrashIds nested in another listed TrashId → 400.
 * - Renames run sequentially; if one fails, already restored folders are renamed back to their
 *   trash names (best effort) and the error is returned.
 * - Lock: exclusive; 409 `tree_busy_streaming` / `tree_busy_structural` like move/delete.
 */
export type RestoreSemantics = never;

/** Endpoint table (documentation aid). */
export interface NodeRoutes {
  'POST /api/trees/:tree/nodes/delete': { body: DeleteNodesRequest; response: DeleteNodesResponse };
  'POST /api/trees/:tree/nodes/move': { body: MoveNodesRequest; response: MoveNodesResponse };
  'POST /api/trees/:tree/nodes/restore': {
    body: RestoreNodesRequest;
    response: RestoreNodesResponse;
  };
}
