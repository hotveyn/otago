import type { HierarchyNode } from '../api/types';

export const ROOT_ID = '';

export function parentIdOf(id: string): string {
  const index = id.lastIndexOf('/');
  return index === -1 ? '' : id.slice(0, index);
}

export function nameOf(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

/** True when `id` equals `ancestorId` or lies inside it. Root contains everything. */
export function isSameOrDescendant(id: string, ancestorId: string): boolean {
  if (ancestorId === '') return true;
  return id === ancestorId || id.startsWith(`${ancestorId}/`);
}

/** Ids from the top-level ancestor down to `id`. Root → []. */
export function chainIds(id: string): string[] {
  if (id === '') return [];
  const segments = id.split('/');
  return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}

/** Depth-first list of all nodes with their depth. */
export function flatten(
  nodes: HierarchyNode[],
  depth = 0,
): { node: HierarchyNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

export function findNode(nodes: HierarchyNode[], id: string): HierarchyNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (isSameOrDescendant(id, node.id)) return findNode(node.children, id);
  }
  return undefined;
}

/** Drop duplicates and ids whose ancestor is also selected (they go with the ancestor). */
export function topLevelIds(ids: Iterable<string>): string[] {
  const unique = [...new Set(ids)];
  return unique.filter(
    (id) => !unique.some((other) => other !== id && isSameOrDescendant(id, other)),
  );
}

function subtreeSize(node: HierarchyNode): number {
  return 1 + node.children.reduce((sum, child) => sum + subtreeSize(child), 0);
}

/** Number of nodes a delete of `ids` removes, descendants included. */
export function countWithDescendants(nodes: HierarchyNode[], ids: Iterable<string>): number {
  return topLevelIds(ids).reduce((sum, id) => {
    const node = findNode(nodes, id);
    return sum + (node ? subtreeSize(node) : 0);
  }, 0);
}

/** Where the current node ends up after deleting `ids`: itself, or its nearest surviving ancestor. */
export function afterDelete(currentId: string, ids: Iterable<string>): string {
  const hit = topLevelIds(ids).find((id) => isSameOrDescendant(currentId, id) && id !== '');
  return hit === undefined ? currentId : parentIdOf(hit);
}

/** New id of `currentId` after a move that returned `moved` (old top-level id → new id). */
export function afterMove(currentId: string, moved: Record<string, string>): string {
  for (const [from, to] of Object.entries(moved)) {
    if (isSameOrDescendant(currentId, from)) return to + currentId.slice(from.length);
  }
  return currentId;
}

/** Can the whole selection be moved under `targetId`? */
export function canMoveTo(selection: Iterable<string>, targetId: string): boolean {
  const ids = topLevelIds(selection);
  if (ids.length === 0) return false;
  return ids.every((id) => !(targetId !== '' && isSameOrDescendant(targetId, id)));
}
