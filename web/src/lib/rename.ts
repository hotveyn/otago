import type { TreeMeta } from '../api/types';

/** Max length of a node name / tree title input (contract `MAX_NAME_LENGTH`). */
export const MAX_NAME_LENGTH = 200;

/**
 * Node the graph's Rename acts on: the single selected node, or the current node when nothing
 * is selected and it is not the root; otherwise `null` (no Rename button).
 */
export function renameTargetOf(selection: Iterable<string>, currentId: string): string | null {
  const ids = [...new Set(selection)];
  if (ids.length === 1) return ids[0] ?? null;
  if (ids.length === 0 && currentId !== '') return currentId;
  return null;
}

/** A rename can be sent: non-blank, different from the current name, within the length cap. */
export function canSubmitRename(currentName: string, input: string): boolean {
  const trimmed = input.trim();
  return trimmed !== '' && trimmed !== currentName && input.length <= MAX_NAME_LENGTH;
}

export interface TreePatch {
  title?: string;
  instructions?: string;
}

/**
 * Only the changed fields of the tree settings form; `null` when nothing changed. A blank title
 * is never sent. Sending `title` renames the folder and takes the tree's exclusive lock, so an
 * instructions-only edit must not include it.
 */
export function treePatchOf(
  tree: Pick<TreeMeta, 'title' | 'instructions'>,
  title: string,
  instructions: string,
): TreePatch | null {
  const patch: TreePatch = {};
  const trimmed = title.trim();
  if (trimmed !== '' && trimmed !== tree.title) patch.title = trimmed;
  if (instructions.trim() !== tree.instructions) patch.instructions = instructions;
  return Object.keys(patch).length === 0 ? null : patch;
}
