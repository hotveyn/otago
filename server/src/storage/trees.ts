import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidInputError, NotFoundError } from '../errors.js';
import { parseTreeFile, serializeTreeFile, type TreeFile } from './format.js';
import { createDirAtomic, exists, isErrno, uniqueName, writeFileAtomic } from './fs-utils.js';
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
  const id = await uniqueName(treesDir, toKebabCase(title, 'tree'));
  const tree: TreeFile = {
    title,
    created: now.toISOString(),
    instructions: (input.instructions ?? '').trim(),
  };
  await createDirAtomic(treesDir, id, { [TREE_FILE]: serializeTreeFile(tree) });
  return { id, ...tree };
}

export async function updateTree(
  treesDir: string,
  treeId: string,
  patch: { title?: string; instructions?: string },
): Promise<TreeMeta> {
  const dir = await existingTreeDir(treesDir, treeId);
  const current = await readTreeFile(dir);
  const next: TreeFile = { ...current };
  if (patch.title !== undefined) {
    next.title = patch.title.trim();
    if (!next.title) throw new InvalidInputError('Title is required');
  }
  if (patch.instructions !== undefined) next.instructions = patch.instructions.trim();
  await writeFileAtomic(path.join(dir, TREE_FILE), serializeTreeFile(next));
  return { id: treeId, ...next };
}

/** Resolve a tree folder, throwing 404 when it has no `tree.md`. */
export async function existingTreeDir(treesDir: string, treeId: string): Promise<string> {
  let dir: string;
  try {
    dir = treeDirOf(treesDir, treeId);
  } catch {
    throw new NotFoundError(`Tree not found: ${treeId}`);
  }
  if (!(await exists(path.join(dir, TREE_FILE)))) {
    throw new NotFoundError(`Tree not found: ${treeId}`);
  }
  return dir;
}

async function readTreeFile(dir: string): Promise<TreeFile> {
  try {
    return parseTreeFile(await readFile(path.join(dir, TREE_FILE), 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new NotFoundError(`Tree not found: ${path.basename(dir)}`);
    throw error;
  }
}

function byCreated(a: { created: string; id: string }, b: { created: string; id: string }): number {
  return a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
}
