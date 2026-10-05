import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { InvalidInputError, NotFoundError } from '../errors.js';
import { type AttachmentInfo, listAttachments } from './attachments.js';
import { type NodeFile, parseNodeFile, serializeNodeFile } from './format.js';
import { claimUniqueName, createDirAtomic, exists, isErrno } from './fs-utils.js';
import { isNodeName, nameKey, toNodeName } from './node-names.js';
import {
  deletedNameFor,
  isReservedName,
  isSameOrDescendant,
  joinId,
  NODE_FILE,
  nodeDirOf,
  nodeIdSegments,
  parentIdOf,
  parseTrashId,
  reservedNamesFor,
  trashDirOf,
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
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ raw: entry.name, name: entry.name.normalize('NFC') }))
    // Folders already in NFC first (they are what an NFC id resolves to), then by name.
    .sort(
      (a, b) =>
        Number(a.raw !== a.name) - Number(b.raw !== b.name) ||
        (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0),
    );
  const seen = new Set<string>();
  const nodes: HierarchyNode[] = [];
  for (const { raw, name } of entries) {
    if (!isNodeName(name) || isReservedName(parentId, name)) continue;
    // NFC/NFD twins (or fold twins) on a normalization-sensitive file system: keep the first.
    const key = nameKey(name);
    if (seen.has(key)) continue;
    const nodeDir = path.join(dir, raw);
    const node = await readNodeFileIfExists(nodeDir);
    if (!node) continue;
    seen.add(key);
    const id = joinId(parentId, name);
    nodes.push({
      id,
      name,
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
  if (!(await nodeExists(treeDir, nodeId))) {
    throw new NotFoundError(`Node not found: ${nodeId}`, 'node_not_found');
  }
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
  const base = toNodeName(desiredName);
  const reserved = reservedNamesFor(parentId);
  const content = serializeNodeFile(node);
  const { stagingDir } = options;
  if (stagingDir) await writeFile(path.join(stagingDir, NODE_FILE), content, 'utf8');
  // Names are claimed in-process, so concurrent creations under one parent never pick the
  // same name. No-overwrite invariant: `node.md` is always in the source folder (staging dir
  // or `createDirAtomic` temp dir) before the rename, so a rename onto an existing non-empty
  // folder fails (EEXIST/ENOTEMPTY) instead of replacing it. The retry covers other
  // processes, external writers and fold collisions `readdir` cannot see; a failed candidate
  // is skipped by key, so the next attempt advances to the next suffix.
  const skip = new Set<string>();
  for (let attempt = 0; attempt < 10; attempt++) {
    const { name, release } = await claimUniqueName(parentDir, base, reserved, { skip });
    try {
      if (stagingDir) await rename(stagingDir, path.join(parentDir, name));
      else await createDirAtomic(parentDir, name, { [NODE_FILE]: content });
      return joinId(parentId, name);
    } catch (error) {
      if (!isErrno(error, 'EEXIST', 'ENOTEMPTY')) throw error;
      skip.add(nameKey(name));
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

/**
 * Soft-delete nodes with their subtrees: each top-level selected folder is renamed in place to
 * `<name>.deleted-<now>` (see `DELETED_NAME_RE`). Returns top-level node id → trash id.
 */
export async function deleteNodes(
  treeDir: string,
  ids: string[],
  now = Date.now(),
): Promise<Record<string, string>> {
  const selected = await validateSelection(treeDir, ids);
  const deleted: Record<string, string> = {};
  for (const id of selected) {
    const parentId = parentIdOf(id);
    const parentDir = nodeDirOf(treeDir, parentId);
    const name = id.slice(id.lastIndexOf('/') + 1);
    deleted[id] = await renameToTrash(nodeDirOf(treeDir, id), parentDir, parentId, name, now);
  }
  return deleted;
}

/** Rename `fromDir` to a free `<name>.deleted-<now>[-n]` in `parentDir`. Returns the trash id. */
async function renameToTrash(
  fromDir: string,
  parentDir: string,
  parentId: string,
  name: string,
  now: number,
): Promise<string> {
  for (let counter = 1; counter <= 10; counter++) {
    const folder = deletedNameFor(name, now, counter);
    const target = path.join(parentDir, folder);
    // `rename` onto an existing empty folder succeeds on POSIX, so check first.
    if (await exists(target)) continue;
    try {
      await rename(fromDir, target);
      return joinId(parentId, folder);
    } catch (error) {
      if (!isErrno(error, 'EEXIST', 'ENOTEMPTY')) throw error;
    }
  }
  throw new Error(`Could not delete node "${joinId(parentId, name)}"`);
}

/**
 * Claim a unique name based on `base` in `parentDir` and rename `fromDir` to it.
 * Returns the claimed name. The claim is released afterwards. With `self` (the current name
 * of `fromDir` inside `parentDir`), that name counts as free; picking it means no rename.
 * Retries with a fresh claim when another writer took the name meanwhile.
 */
async function renameClaimed(
  fromDir: string,
  parentDir: string,
  base: string,
  reserved: ReadonlySet<string>,
  options: { self?: string } = {},
): Promise<string> {
  const skip = new Set<string>();
  for (let attempt = 0; attempt < 10; attempt++) {
    const { name, release } = await claimUniqueName(parentDir, base, reserved, {
      ...options,
      skip,
    });
    try {
      if (name === options.self) return name;
      await rename(fromDir, path.join(parentDir, name));
      return name;
    } catch (error) {
      if (!isErrno(error, 'EEXIST', 'ENOTEMPTY')) throw error;
      skip.add(nameKey(name));
    } finally {
      release();
    }
  }
  throw new Error(`Could not rename "${path.basename(fromDir)}"`);
}

export interface RenameNodeResult {
  /** Resulting id of the renamed node. */
  id: string;
  /** Resulting folder name (last segment of `id`). */
  name: string;
  /** Old id → new id for the node and every live descendant (node first, hierarchy order). */
  renamed: Record<string, string>;
}

/** Ids of all live descendants of `id` (depth-first, hierarchy order). */
async function descendantIds(nodeDir: string, id: string): Promise<string[]> {
  const flatten = (nodes: HierarchyNode[]): string[] =>
    nodes.flatMap((child) => [child.id, ...flatten(child.children)]);
  return flatten(await readChildren(nodeDir, id));
}

/** Map `ids` (all equal to or inside `oldId`) to their ids after `oldId` became `newId`. */
export function remapSubtree(ids: string[], oldId: string, newId: string): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, newId + id.slice(oldId.length)]));
}

/**
 * Rename a node folder in place (same parent) to a unique node name based on `desiredName`
 * (`toNodeName`, Unicode). The node's own current name counts as free, so the same name is a
 * no-op.
 */
export async function renameNode(
  treeDir: string,
  id: string,
  desiredName: string,
): Promise<RenameNodeResult> {
  if (id === '') throw new InvalidInputError('The tree root cannot be renamed');
  await assertNodeExists(treeDir, id);
  const trimmed = desiredName.trim();
  if (!trimmed) throw new InvalidInputError('Name is required');
  const parentId = parentIdOf(id);
  const current = id.slice(id.lastIndexOf('/') + 1);
  const parentDir = nodeDirOf(treeDir, parentId);
  const nodeDir = nodeDirOf(treeDir, id);
  const subtree = [id, ...(await descendantIds(nodeDir, id))];
  const name = await renameClaimed(
    nodeDir,
    parentDir,
    toNodeName(trimmed),
    reservedNamesFor(parentId),
    { self: current },
  );
  const newId = joinId(parentId, name);
  return { id: newId, name, renamed: remapSubtree(subtree, id, newId) };
}

export interface MoveNodesOptions {
  /** Selected id → desired folder name at the target (claimed uniquely). */
  names?: Record<string, string>;
}

/** Move nodes with their subtrees under `targetParentId`. Returns old id → new id. */
export async function moveNodes(
  treeDir: string,
  ids: string[],
  targetParentId: string,
  options: MoveNodesOptions = {},
): Promise<Record<string, string>> {
  const names = options.names ?? {};
  const reserved = reservedNamesFor(targetParentId);
  for (const [key, name] of Object.entries(names)) {
    if (!ids.includes(key))
      throw new InvalidInputError(`Name given for an unselected node: ${key}`);
    if (!isNodeName(name) || isReservedName(targetParentId, name)) {
      throw new InvalidInputError(`Invalid node name: ${name}`);
    }
  }
  const selected = await validateSelection(treeDir, ids);
  if (!(await nodeExists(treeDir, targetParentId))) {
    throw new NotFoundError(`Target parent not found: ${targetParentId}`, 'parent_not_found');
  }
  for (const id of selected) {
    if (targetParentId !== '' && isSameOrDescendant(targetParentId, id)) {
      throw new InvalidInputError(`Cannot move "${id}" into itself or its descendant`);
    }
  }
  const targetDir = nodeDirOf(treeDir, targetParentId);
  const moved: Record<string, string> = {};
  for (const id of selected) {
    if (parentIdOf(id) === targetParentId) {
      moved[id] = id;
      continue;
    }
    const base = names[id] ?? id.slice(id.lastIndexOf('/') + 1);
    const name = await renameClaimed(nodeDirOf(treeDir, id), targetDir, base, reserved);
    moved[id] = joinId(targetParentId, name);
  }
  return moved;
}

/**
 * Restore soft-deleted nodes in place (same parent), under their original name or a `-2`, `-3`, …
 * variant if a live sibling took it. All trash ids are validated before anything is renamed.
 * Returns trash id → restored node id.
 */
export async function restoreNodes(
  treeDir: string,
  trashIds: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(trashIds)];
  if (unique.length === 0) throw new InvalidInputError('No deleted nodes selected');
  const parsed = unique.map((trashId) => ({ trashId, ...parseTrashId(trashId) }));
  for (const a of unique) {
    for (const b of unique) {
      if (a !== b && isSameOrDescendant(a, b)) {
        throw new InvalidInputError(`Deleted node "${a}" lies inside "${b}"`);
      }
    }
  }
  for (const item of parsed) {
    if (!(await nodeExists(treeDir, item.parentId))) {
      throw new NotFoundError(`Parent not found: ${item.parentId}`, 'parent_not_found');
    }
    if (!(await exists(path.join(trashDirOf(treeDir, item.trashId), NODE_FILE)))) {
      throw new NotFoundError(`Deleted node not found: ${item.trashId}`, 'trash_not_found');
    }
  }
  const restored: Record<string, string> = {};
  const done: Array<{ liveDir: string; trashDir: string }> = [];
  try {
    for (const item of parsed) {
      const parentDir = nodeDirOf(treeDir, item.parentId);
      const trashDir = trashDirOf(treeDir, item.trashId);
      const name = await renameClaimed(
        trashDir,
        parentDir,
        item.originalName,
        reservedNamesFor(item.parentId),
      );
      done.push({ liveDir: path.join(parentDir, name), trashDir });
      restored[item.trashId] = joinId(item.parentId, name);
    }
  } catch (error) {
    for (const { liveDir, trashDir } of done.reverse()) {
      await rename(liveDir, trashDir).catch(() => undefined);
    }
    throw error;
  }
  return restored;
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
