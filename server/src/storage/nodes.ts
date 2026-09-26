import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidInputError, NotFoundError } from '../errors.js';
import { type AttachmentInfo, listAttachments } from './attachments.js';
import { type NodeFile, parseNodeFile, serializeNodeFile } from './format.js';
import { claimUniqueName, createDirAtomic, exists, isErrno } from './fs-utils.js';
import {
  isSameOrDescendant,
  isSlug,
  joinId,
  NODE_FILE,
  nodeDirOf,
  nodeIdSegments,
  parentIdOf,
  RESERVED_NODE_NAMES,
  RESERVED_ROOT_NAMES,
  reservedNamesFor,
  toKebabCase,
} from './paths.js';
import { listUserFiles, type UserFileInfo } from './user-files.js';

export interface HierarchyNode {
  id: string;
  name: string;
  created: string;
  children: HierarchyNode[];
}

export interface ChainNode extends NodeFile {
  id: string;
  name: string;
  /** Files in `<node>/attachments/`, sorted by name. */
  attachments: AttachmentInfo[];
  /** Files in `<node>/files/` (user uploads), sorted by name. */
  files: UserFileInfo[];
}

/** All nodes of a tree, siblings sorted by `created`. */
export async function readHierarchy(treeDir: string): Promise<HierarchyNode[]> {
  return readChildren(treeDir, '');
}

async function readChildren(dir: string, parentId: string): Promise<HierarchyNode[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes: HierarchyNode[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSlug(entry.name)) continue;
    if (RESERVED_NODE_NAMES.has(entry.name)) continue;
    if (parentId === '' && RESERVED_ROOT_NAMES.has(entry.name)) continue;
    const nodeDir = path.join(dir, entry.name);
    const node = await readNodeFileIfExists(nodeDir);
    if (!node) continue;
    const id = joinId(parentId, entry.name);
    nodes.push({
      id,
      name: entry.name,
      created: node.created,
      children: await readChildren(nodeDir, id),
    });
  }
  return nodes.sort((a, b) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name));
}

/** Nodes from the top-level ancestor down to `nodeId`. `""` → empty chain. */
export async function readChain(treeDir: string, nodeId: string): Promise<ChainNode[]> {
  const segments = nodeIdSegments(nodeId);
  const chain: ChainNode[] = [];
  for (const [i, name] of segments.entries()) {
    const id = segments.slice(0, i + 1).join('/');
    const nodeDir = nodeDirOf(treeDir, id);
    const node = await readNodeFileIfExists(nodeDir);
    if (!node) throw new NotFoundError(`Node not found: ${nodeId}`);
    chain.push({
      id,
      name,
      ...node,
      attachments: await listAttachments(nodeDir),
      files: await listUserFiles(nodeDir),
    });
  }
  return chain;
}

export async function nodeExists(treeDir: string, nodeId: string): Promise<boolean> {
  if (nodeId === '') return true;
  return (await readNodeFileIfExists(nodeDirOf(treeDir, nodeId))) !== null;
}

export async function assertNodeExists(treeDir: string, nodeId: string): Promise<void> {
  if (!(await nodeExists(treeDir, nodeId))) throw new NotFoundError(`Node not found: ${nodeId}`);
}

export interface CreateNodeOptions {
  /**
   * Prepared folder inside the parent folder (e.g. an answer staging folder with
   * `attachments/` and the user's `files/`). `node.md` is written into it and the folder is renamed into place.
   * On failure it is left as is; the caller discards it.
   */
  stagingDir?: string;
}

/** Create `parentId/<name>/node.md` atomically. Returns the new node id. */
export async function createNode(
  treeDir: string,
  parentId: string,
  desiredName: string,
  node: NodeFile,
  options: CreateNodeOptions = {},
): Promise<string> {
  await assertNodeExists(treeDir, parentId);
  const parentDir = nodeDirOf(treeDir, parentId);
  const base = toKebabCase(desiredName);
  const reserved = reservedNamesFor(parentId);
  const content = serializeNodeFile(node);
  const { stagingDir } = options;
  if (stagingDir) await writeFile(path.join(stagingDir, NODE_FILE), content, 'utf8');
  // Names are claimed in-process, so concurrent creations under one parent never pick the
  // same name. No-overwrite invariant: `node.md` is always in the source folder (staging dir
  // or `createDirAtomic` temp dir) before the rename, so a rename onto an existing non-empty
  // folder fails (EEXIST/ENOTEMPTY) instead of replacing it. The retry covers other
  // processes and external writers.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { name, release } = await claimUniqueName(parentDir, base, reserved);
    try {
      if (stagingDir) await rename(stagingDir, path.join(parentDir, name));
      else await createDirAtomic(parentDir, name, { [NODE_FILE]: content });
      return joinId(parentId, name);
    } catch (error) {
      if (!isErrno(error, 'EEXIST', 'ENOTEMPTY')) throw error;
    } finally {
      // After a successful rename the name is visible to `readdir`; the claim is not needed.
      release();
    }
  }
  throw new Error(`Could not create node under "${parentId}"`);
}

/** Drop duplicates and ids whose ancestor is also selected. */
export function topLevelIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.filter(
    (id) => !unique.some((other) => other !== id && isSameOrDescendant(id, other)),
  );
}

async function validateSelection(treeDir: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) throw new InvalidInputError('No nodes selected');
  for (const id of ids) {
    if (id === '') throw new InvalidInputError('The tree root cannot be selected');
    await assertNodeExists(treeDir, id);
  }
  return topLevelIds(ids);
}

/** Delete nodes with their subtrees. */
export async function deleteNodes(treeDir: string, ids: string[]): Promise<void> {
  const selected = await validateSelection(treeDir, ids);
  for (const id of selected) {
    await rm(nodeDirOf(treeDir, id), { recursive: true });
  }
}

/** Move nodes with their subtrees under `targetParentId`. Returns old id → new id. */
export async function moveNodes(
  treeDir: string,
  ids: string[],
  targetParentId: string,
): Promise<Record<string, string>> {
  const selected = await validateSelection(treeDir, ids);
  await assertNodeExists(treeDir, targetParentId);
  for (const id of selected) {
    if (targetParentId !== '' && isSameOrDescendant(targetParentId, id)) {
      throw new InvalidInputError(`Cannot move "${id}" into itself or its descendant`);
    }
  }
  const targetDir = nodeDirOf(treeDir, targetParentId);
  const reserved = reservedNamesFor(targetParentId);
  const moved: Record<string, string> = {};
  for (const id of selected) {
    if (parentIdOf(id) === targetParentId) {
      moved[id] = id;
      continue;
    }
    const base = id.slice(id.lastIndexOf('/') + 1);
    const { name, release } = await claimUniqueName(targetDir, base, reserved);
    try {
      await rename(nodeDirOf(treeDir, id), path.join(targetDir, name));
    } finally {
      release();
    }
    moved[id] = joinId(targetParentId, name);
  }
  return moved;
}

async function readNodeFileIfExists(nodeDir: string): Promise<NodeFile | null> {
  const file = path.join(nodeDir, NODE_FILE);
  if (!(await exists(file))) return null;
  try {
    return parseNodeFile(await readFile(file, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }
}
