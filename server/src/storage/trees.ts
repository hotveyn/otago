import { mkdir, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { InvalidInputError, NotFoundError } from '../errors.js';
import { parseTreeFile, serializeTreeFile, type TreeFile } from './format.js';
import { claimUniqueName, createDirAtomic, exists, isErrno, writeFileAtomic } from './fs-utils.js';
import { isSlug, TREE_FILE, toKebabCase, treeDirOf } from './paths.js';

export interface TreeMeta extends TreeFile {
  id: string;
}

export async function listTrees(treesDir: string): Promise<TreeMeta[]> {
  await mkdir(treesDir, { recursive: true });
  const entries = await readdir(treesDir, { withFileTypes: true });
  const trees: TreeMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSlug(entry.name)) continue;
    const tree = await readTreeFile(path.join(treesDir, entry.name)).catch(() => null);
    if (tree) trees.push({ id: entry.name, ...tree });
  }
  return trees.sort(byCreated);
}

export async function readTree(treesDir: string, treeId: string): Promise<TreeMeta> {
  const dir = await existingTreeDir(treesDir, treeId);
  return { id: treeId, ...(await readTreeFile(dir)) };
}

export async function createTree(
  treesDir: string,
  input: { title: string; instructions?: string },
  now = new Date(),
): Promise<TreeMeta> {
  const title = input.title.trim();
  if (!title) throw new InvalidInputError('Title is required');
  await mkdir(treesDir, { recursive: true });
  const tree: TreeFile = {
    title,
    created: now.toISOString(),
    instructions: (input.instructions ?? '').trim(),
  };
  // Claimed in-process, so a concurrent create or rename never picks the same id.
  const { name: id, release } = await claimUniqueName(treesDir, toKebabCase(title, 'tree'));
  try {
    await createDirAtomic(treesDir, id, { [TREE_FILE]: serializeTreeFile(tree) });
  } finally {
    release();
  }
  return { id, ...tree };
}

export interface UpdateTreeResult extends TreeMeta {
  /** State before the update (equals the new values when nothing changed). */
  previous: { id: string; title: string };
}

export interface UpdateTreeOptions {
  /**
   * Called with the new tree id right before the folder is renamed (only when the id
   * changes). May throw (e.g. 409) to abort; the returned release runs after the update.
   */
  lockTarget?: (newId: string) => () => void;
}

/**
 * Update title and/or instructions. A title change also renames the tree folder to match
 * (`toKebabCase(title, 'tree')`, unique among trees, own name counts as free). If writing
 * `tree.md` fails after the folder rename, the folder is renamed back.
 */
export async function updateTree(
  treesDir: string,
  treeId: string,
  patch: { title?: string; instructions?: string },
  options: UpdateTreeOptions = {},
): Promise<UpdateTreeResult> {
  const dir = await existingTreeDir(treesDir, treeId);
  const current = await readTreeFile(dir);
  const next: TreeFile = { ...current };
  if (patch.title !== undefined) {
    next.title = patch.title.trim();
    if (!next.title) throw new InvalidInputError('Title is required');
  }
  if (patch.instructions !== undefined) next.instructions = patch.instructions.trim();
  const previous = { id: treeId, title: current.title };
  const content = serializeTreeFile(next);
  if (patch.title === undefined) {
    await writeFileAtomic(path.join(dir, TREE_FILE), content);
    return { id: treeId, ...next, previous };
  }
  const base = toKebabCase(next.title, 'tree');
  for (let attempt = 0; attempt < 10; attempt++) {
    const { name: newId, release } = await claimUniqueName(treesDir, base, undefined, {
      self: treeId,
    });
    try {
      if (newId === treeId) {
        await writeFileAtomic(path.join(dir, TREE_FILE), content);
        return { id: treeId, ...next, previous };
      }
      const releaseTarget = options.lockTarget?.(newId);
      try {
        const newDir = path.join(treesDir, newId);
        try {
          await rename(dir, newDir);
        } catch (error) {
          if (isErrno(error, 'EEXIST', 'ENOTEMPTY')) continue;
          throw error;
        }
        try {
          await writeFileAtomic(path.join(newDir, TREE_FILE), content);
        } catch (error) {
          await rename(newDir, dir).catch(() => undefined);
          throw error;
        }
        return { id: newId, ...next, previous };
      } finally {
        releaseTarget?.();
      }
    } finally {
      release();
    }
  }
  throw new Error(`Could not rename tree "${treeId}"`);
}

/** Resolve a tree folder, throwing 404 when it has no `tree.md`. */
export async function existingTreeDir(treesDir: string, treeId: string): Promise<string> {
  let dir: string;
  try {
    dir = treeDirOf(treesDir, treeId);
  } catch {
    throw new NotFoundError(`Tree not found: ${treeId}`, 'tree_not_found');
  }
  if (!(await exists(path.join(dir, TREE_FILE)))) {
    throw new NotFoundError(`Tree not found: ${treeId}`, 'tree_not_found');
  }
  return dir;
}

async function readTreeFile(dir: string): Promise<TreeFile> {
  try {
    return parseTreeFile(await readFile(path.join(dir, TREE_FILE), 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT'))
      throw new NotFoundError(`Tree not found: ${path.basename(dir)}`, 'tree_not_found');
    throw error;
  }
}

function byCreated(a: { created: string; id: string }, b: { created: string; id: string }): number {
  return a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
}
