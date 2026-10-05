/**
 * Trees, nodes, sources and node files on the VFS: the storage layer of the mock backend,
 * mirroring `server/src/storage/{trees,nodes,sources,attachments,user-files}.ts`.
 * Every method is synchronous and runs in one VFS transaction, so it is atomic.
 */
import type {
  AttachmentInfo,
  ChainNode,
  FileFolder,
  HierarchyNode,
  SourceInfo,
  TreeMeta,
  UpdateTreeResult,
  UserFileInfo,
} from '../../../web/src/api/types';
import { badRequest, notFound, storageFull, treeNotFound } from './errors';
import {
  assertSourceName,
  fileContentTypeOf,
  fileInfoOf,
  isNodeFileName,
  isSourceName,
  sourceContentTypeOf,
} from './files';
import {
  type NodeFile,
  parseNodeFile,
  parseTreeFile,
  serializeNodeFile,
  serializeTreeFile,
} from './format';
import {
  ATTACHMENTS_DIR,
  deletedNameFor,
  isNodeName,
  isReservedName,
  isSameOrDescendant,
  isTreeId,
  joinId,
  lastSegment,
  NODE_FILE,
  nodeIdSegments,
  parentIdOf,
  parseTrashId,
  reservedNamesFor,
  SOURCES_DIR,
  TREE_FILE,
  toNodeName,
  toTreeId,
  USER_FILES_DIR,
  uniqueName,
} from './names';
import { joinPath, StorageFullError, type Vfs } from './vfs';

export interface StoredFile {
  name: string;
  bytes: Uint8Array;
}

export interface FileContent {
  bytes: Uint8Array;
  contentType: string;
}

const byCreated = (a: { created: string; id: string }, b: { created: string; id: string }) =>
  a.created.localeCompare(b.created) || a.id.localeCompare(b.id);

/** Drop duplicates and ids whose ancestor is also selected. */
export function topLevelIds(ids: string[]): string[] {
  const unique = [...new Set(ids)];
  return unique.filter(
    (id) => !unique.some((other) => other !== id && isSameOrDescendant(id, other)),
  );
}

export class TreeStore {
  constructor(private readonly vfs: Vfs) {}

  /** Run a mutation atomically; a full storage becomes the demo's 413. */
  private mutate<T>(fn: () => T): T {
    try {
      return this.vfs.transaction(fn);
    } catch (error) {
      if (error instanceof StorageFullError) throw storageFull();
      throw error;
    }
  }

  // --- Trees ------------------------------------------------------------------------------

  listTrees(): TreeMeta[] {
    const trees: TreeMeta[] = [];
    for (const id of this.vfs.listDirs('')) {
      if (!isTreeId(id)) continue;
      const tree = this.readTreeFile(id);
      if (tree) trees.push({ id, ...tree });
    }
    return trees.sort(byCreated);
  }

  readTree(treeId: string): TreeMeta {
    const tree = this.readTreeFile(treeId);
    if (!tree) throw treeNotFound(treeId);
    return { id: treeId, ...tree };
  }

  assertTree(treeId: string): void {
    this.readTree(treeId);
  }

  createTree(input: { title: string; instructions?: string }, now = new Date()): TreeMeta {
    const title = input.title.trim();
    if (!title) throw badRequest('Title is required');
    const tree = {
      title,
      created: now.toISOString(),
      instructions: (input.instructions ?? '').trim(),
    };
    const id = uniqueName(toTreeId(title, 'tree'), this.vfs.list(''));
    this.mutate(() => this.vfs.writeText(joinPath(id, TREE_FILE), serializeTreeFile(tree)));
    return { id, ...tree };
  }

  /** Title and/or instructions; a title change renames the tree folder (`toTreeId`). */
  updateTree(treeId: string, patch: { title?: string; instructions?: string }): UpdateTreeResult {
    const current = this.readTree(treeId);
    const next = {
      title: current.title,
      created: current.created,
      instructions: current.instructions,
    };
    if (patch.title !== undefined) {
      next.title = patch.title.trim();
      if (!next.title) throw badRequest('Title is required');
    }
    if (patch.instructions !== undefined) next.instructions = patch.instructions.trim();
    const previous = { id: treeId, title: current.title };
    const newId =
      patch.title === undefined
        ? treeId
        : uniqueName(toTreeId(next.title, 'tree'), this.vfs.list(''), undefined, treeId);
    this.mutate(() => {
      if (newId !== treeId) this.vfs.rename(treeId, newId);
      this.vfs.writeText(joinPath(newId, TREE_FILE), serializeTreeFile(next));
    });
    return { id: newId, ...next, previous };
  }

  /** The new tree id a title would give (to lock it before `updateTree`). */
  treeIdForTitle(treeId: string, title: string): string {
    return uniqueName(toTreeId(title.trim(), 'tree'), this.vfs.list(''), undefined, treeId);
  }

  private readTreeFile(treeId: string) {
    if (!isTreeId(treeId)) return null;
    const text = this.vfs.readText(joinPath(treeId, TREE_FILE));
    if (text === null) return null;
    try {
      return parseTreeFile(text);
    } catch {
      return null;
    }
  }

  // --- Nodes ------------------------------------------------------------------------------

  /** All nodes of a tree, siblings sorted by `created`. */
  hierarchy(treeId: string): HierarchyNode[] {
    this.assertTree(treeId);
    return this.readChildren(treeId, '');
  }

  private readChildren(treeId: string, parentId: string): HierarchyNode[] {
    const dir = this.dirOf(treeId, parentId);
    const nodes: HierarchyNode[] = [];
    for (const name of this.vfs.listDirs(dir)) {
      if (!isNodeName(name) || isReservedName(parentId, name)) continue;
      const id = joinId(parentId, name);
      const node = this.readNodeFile(treeId, id);
      if (!node) continue;
      nodes.push({ id, name, created: node.created, children: this.readChildren(treeId, id) });
    }
    return nodes.sort((a, b) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name));
  }

  /** Nodes from the top-level ancestor down to `nodeId`. `""` → empty chain. */
  chain(treeId: string, nodeId: string): ChainNode[] {
    this.assertTree(treeId);
    const segments = nodeIdSegments(nodeId);
    return segments.map((name, i) => {
      const id = segments.slice(0, i + 1).join('/');
      const node = this.readNodeFile(treeId, id);
      if (!node) throw notFound(`Node not found: ${nodeId}`);
      return {
        id,
        name,
        ...node,
        attachments: this.listNodeFiles(treeId, id, ATTACHMENTS_DIR),
        files: this.listNodeFiles(treeId, id, USER_FILES_DIR),
      };
    });
  }

  nodeExists(treeId: string, nodeId: string): boolean {
    if (nodeId === '') return true;
    nodeIdSegments(nodeId);
    return this.readNodeFile(treeId, nodeId) !== null;
  }

  private assertNode(treeId: string, nodeId: string): void {
    if (!this.nodeExists(treeId, nodeId)) {
      throw notFound(`Node not found: ${nodeId}`, 'node_not_found');
    }
  }

  /** Create `parentId/<name>/` with `node.md` and the user files. Returns the new node id. */
  createNode(
    treeId: string,
    parentId: string,
    desiredName: string,
    node: NodeFile,
    files: readonly StoredFile[] = [],
  ): string {
    this.assertTree(treeId);
    this.assertNode(treeId, parentId);
    const parentDir = this.dirOf(treeId, parentId);
    const name = uniqueName(
      toNodeName(desiredName),
      this.vfs.list(parentDir),
      reservedNamesFor(parentId),
    );
    const id = joinId(parentId, name);
    const dir = joinPath(parentDir, name);
    this.mutate(() => {
      this.vfs.writeText(joinPath(dir, NODE_FILE), serializeNodeFile(node));
      for (const file of files)
        this.vfs.writeBytes(joinPath(dir, USER_FILES_DIR, file.name), file.bytes);
    });
    return id;
  }

  private validateSelection(treeId: string, ids: string[]): string[] {
    if (ids.length === 0) throw badRequest('No nodes selected');
    for (const id of ids) {
      if (id === '') throw badRequest('The tree root cannot be selected');
      this.assertNode(treeId, id);
    }
    return topLevelIds(ids);
  }

  /** Soft delete: rename to `<name>.deleted-<now>`. Returns top-level id → trash id. */
  deleteNodes(treeId: string, ids: string[], now = Date.now()): Record<string, string> {
    this.assertTree(treeId);
    const selected = this.validateSelection(treeId, ids);
    return this.mutate(() => {
      const deleted: Record<string, string> = {};
      for (const id of selected) {
        const parentId = parentIdOf(id);
        const parentDir = this.dirOf(treeId, parentId);
        for (let counter = 1; ; counter++) {
          const folder = deletedNameFor(lastSegment(id), now, counter);
          if (this.vfs.exists(joinPath(parentDir, folder))) continue;
          this.vfs.rename(this.dirOf(treeId, id), joinPath(parentDir, folder));
          deleted[id] = joinId(parentId, folder);
          break;
        }
      }
      return deleted;
    });
  }

  /** Move nodes with their subtrees under `targetParentId`. Returns old id → new id. */
  moveNodes(
    treeId: string,
    ids: string[],
    targetParentId: string,
    names: Record<string, string> = {},
  ): Record<string, string> {
    this.assertTree(treeId);
    for (const [key, name] of Object.entries(names)) {
      if (!ids.includes(key)) throw badRequest(`Name given for an unselected node: ${key}`);
      if (!isNodeName(name) || isReservedName(targetParentId, name)) {
        throw badRequest(`Invalid node name: ${name}`);
      }
    }
    const selected = this.validateSelection(treeId, ids);
    if (!this.nodeExists(treeId, targetParentId)) {
      throw notFound(`Target parent not found: ${targetParentId}`, 'parent_not_found');
    }
    for (const id of selected) {
      if (targetParentId !== '' && isSameOrDescendant(targetParentId, id)) {
        throw badRequest(`Cannot move "${id}" into itself or its descendant`);
      }
    }
    const targetDir = this.dirOf(treeId, targetParentId);
    return this.mutate(() => {
      const moved: Record<string, string> = {};
      for (const id of selected) {
        if (parentIdOf(id) === targetParentId) {
          moved[id] = id;
          continue;
        }
        const name = uniqueName(
          names[id] ?? lastSegment(id),
          this.vfs.list(targetDir),
          reservedNamesFor(targetParentId),
        );
        this.vfs.rename(this.dirOf(treeId, id), joinPath(targetDir, name));
        moved[id] = joinId(targetParentId, name);
      }
      return moved;
    });
  }

  /** Restore soft-deleted nodes under their original name (or `-2`…). trash id → node id. */
  restoreNodes(treeId: string, trashIds: string[]): Record<string, string> {
    this.assertTree(treeId);
    const unique = [...new Set(trashIds)];
    if (unique.length === 0) throw badRequest('No deleted nodes selected');
    const parsed = unique.map((trashId) => ({ trashId, ...parseTrashId(trashId) }));
    for (const a of unique) {
      for (const b of unique) {
        if (a !== b && isSameOrDescendant(a, b)) {
          throw badRequest(`Deleted node "${a}" lies inside "${b}"`);
        }
      }
    }
    for (const item of parsed) {
      if (!this.nodeExists(treeId, item.parentId)) {
        throw notFound(`Parent not found: ${item.parentId}`, 'parent_not_found');
      }
      const trashDir = joinPath(this.dirOf(treeId, item.parentId), item.folder);
      if (!this.vfs.isFile(joinPath(trashDir, NODE_FILE))) {
        throw notFound(`Deleted node not found: ${item.trashId}`, 'trash_not_found');
      }
    }
    return this.mutate(() => {
      const restored: Record<string, string> = {};
      for (const item of parsed) {
        const parentDir = this.dirOf(treeId, item.parentId);
        const name = uniqueName(
          item.originalName,
          this.vfs.list(parentDir),
          reservedNamesFor(item.parentId),
        );
        this.vfs.rename(joinPath(parentDir, item.folder), joinPath(parentDir, name));
        restored[item.trashId] = joinId(item.parentId, name);
      }
      return restored;
    });
  }

  /** Rename in place (`toNodeName`, own name counts as free). */
  renameNode(
    treeId: string,
    id: string,
    desiredName: string,
  ): { id: string; name: string; renamed: Record<string, string> } {
    this.assertTree(treeId);
    if (id === '') throw badRequest('The tree root cannot be renamed');
    this.assertNode(treeId, id);
    const trimmed = desiredName.trim();
    if (!trimmed) throw badRequest('Name is required');
    const parentId = parentIdOf(id);
    const current = lastSegment(id);
    const parentDir = this.dirOf(treeId, parentId);
    const flatten = (nodes: HierarchyNode[]): string[] =>
      nodes.flatMap((child) => [child.id, ...flatten(child.children)]);
    const subtree = [id, ...flatten(this.readChildren(treeId, id))];
    const name = uniqueName(
      toNodeName(trimmed),
      this.vfs.list(parentDir),
      reservedNamesFor(parentId),
      current,
    );
    const newId = joinId(parentId, name);
    if (name !== current) {
      this.mutate(() => this.vfs.rename(joinPath(parentDir, current), joinPath(parentDir, name)));
    }
    const renamed = Object.fromEntries(
      subtree.map((oldId) => [oldId, newId + oldId.slice(id.length)]),
    );
    return { id: newId, name, renamed };
  }

  private readNodeFile(treeId: string, nodeId: string): NodeFile | null {
    const text = this.vfs.readText(joinPath(this.dirOf(treeId, nodeId), NODE_FILE));
    if (text === null) return null;
    try {
      return parseNodeFile(text);
    } catch {
      return null;
    }
  }

  /** VFS folder of a node (`""` = the tree folder). Ids must be validated by the caller. */
  private dirOf(treeId: string, nodeId: string): string {
    return joinPath(treeId, nodeId);
  }

  // --- Node files (agent attachments and user files) --------------------------------------

  private listNodeFiles(
    treeId: string,
    nodeId: string,
    folder: FileFolder,
  ): AttachmentInfo[] & UserFileInfo[] {
    const dir = joinPath(this.dirOf(treeId, nodeId), folder);
    return this.vfs
      .listFiles(dir)
      .filter(isNodeFileName)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => fileInfoOf(name, this.vfs.stat(joinPath(dir, name))?.size ?? 0));
  }

  readNodeFileContent(
    treeId: string,
    nodeId: string,
    folder: FileFolder,
    name: string,
  ): FileContent {
    this.assertTree(treeId);
    if (nodeId === '') throw badRequest('Invalid input');
    if (!isNodeFileName(name)) throw badRequest(`Invalid file name: ${name}`);
    this.assertNode(treeId, nodeId);
    const bytes = this.vfs.readBytes(joinPath(this.dirOf(treeId, nodeId), folder, name));
    if (!bytes) {
      throw notFound(`${folder === ATTACHMENTS_DIR ? 'Attachment' : 'File'} not found: ${name}`);
    }
    return { bytes, contentType: fileContentTypeOf(name) };
  }

  /** VFS path of a node file, for blob URLs (no validation: a missing file is just missing). */
  nodeFilePath(treeId: string, nodeId: string, folder: FileFolder, name: string): string {
    return joinPath(treeId, nodeId, folder, name);
  }

  /** Content type of a node file by name (for blob URLs). */
  fileContentType(name: string): string {
    return fileContentTypeOf(name);
  }

  // --- Sources ----------------------------------------------------------------------------

  listSources(treeId: string): SourceInfo[] {
    this.assertTree(treeId);
    const dir = joinPath(treeId, SOURCES_DIR);
    return this.vfs
      .listFiles(dir)
      .filter(isSourceName)
      .map((name) => ({ name, size: this.vfs.stat(joinPath(dir, name))?.size ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readSource(treeId: string, name: string): FileContent {
    this.assertTree(treeId);
    assertSourceName(name);
    const bytes = this.vfs.readBytes(this.sourcePath(treeId, name));
    if (!bytes) throw notFound(`Source not found: ${name}`);
    return { bytes, contentType: sourceContentTypeOf(name) };
  }

  saveSource(treeId: string, name: string, bytes: Uint8Array): SourceInfo {
    this.assertTree(treeId);
    assertSourceName(name);
    this.mutate(() => this.vfs.writeBytes(this.sourcePath(treeId, name), bytes));
    return { name, size: bytes.length };
  }

  deleteSource(treeId: string, name: string): void {
    this.assertTree(treeId);
    assertSourceName(name);
    const path = this.sourcePath(treeId, name);
    if (!this.vfs.isFile(path)) throw notFound(`Source not found: ${name}`);
    this.mutate(() => this.vfs.remove(path));
  }

  sourcePath(treeId: string, name: string): string {
    return joinPath(treeId, SOURCES_DIR, name);
  }

  /** Content type of a source by name (for blob URLs). */
  sourceContentType(name: string): string {
    return sourceContentTypeOf(name);
  }
}
