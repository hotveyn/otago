import path from 'node:path';
import { InvalidInputError } from '../errors.js';

export const TREE_FILE = 'tree.md';
export const NODE_FILE = 'node.md';
export const SOURCES_DIR = 'sources';
export const TEMP_PREFIX = '.tmp-';
/** Folder with the files of one answer, inside every node folder. */
export const ATTACHMENTS_DIR = 'attachments';
/** Folder with the user files of the message that created the node, inside a node folder. */
export const USER_FILES_DIR = 'files';
/** Staging folder of an answer being generated; becomes the node folder on success. */
export const STAGING_PREFIX = `${TEMP_PREFIX}answer-`;

/** Names that cannot be used for a node at any level. */
export const RESERVED_NODE_NAMES: ReadonlySet<string> = new Set([ATTACHMENTS_DIR, USER_FILES_DIR]);

/** Names that cannot be used for a top-level node inside a tree folder. */
export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  TREE_FILE,
  SOURCES_DIR,
  ATTACHMENTS_DIR,
  USER_FILES_DIR,
]);

/** Reserved child names under `parentId` (`""` = tree root). */
export function reservedNamesFor(parentId: string): ReadonlySet<string> {
  return parentId === '' ? RESERVED_ROOT_NAMES : RESERVED_NODE_NAMES;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

/** Lowercase kebab-case, ASCII only. Returns `fallback` when nothing is left. */
export function toKebabCase(input: string, fallback = 'node', maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Resolve `child` under `base`, rejecting anything that escapes it. */
export function resolveInside(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  const root = path.resolve(base);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new InvalidInputError(`Path escapes ${root}`);
  }
  return resolved;
}

export function treeDirOf(treesDir: string, treeId: string): string {
  if (!isSlug(treeId)) throw new InvalidInputError(`Invalid tree id: ${treeId}`);
  return resolveInside(treesDir, treeId);
}

/** Validate a node id (`""` = root) and return its segments. */
export function nodeIdSegments(id: string): string[] {
  if (id === '') return [];
  if (path.isAbsolute(id) || id.includes('\\')) {
    throw new InvalidInputError(`Invalid node id: ${id}`);
  }
  const segments = id.split('/');
  for (const segment of segments) {
    if (!isSlug(segment) || RESERVED_NODE_NAMES.has(segment)) {
      throw new InvalidInputError(`Invalid node id: ${id}`);
    }
  }
  if (RESERVED_ROOT_NAMES.has(segments[0] ?? '')) {
    throw new InvalidInputError(`Invalid node id: ${id}`);
  }
  return segments;
}

export function nodeDirOf(treeDir: string, id: string): string {
  return resolveInside(treeDir, ...nodeIdSegments(id));
}

export function parentIdOf(id: string): string {
  const index = id.lastIndexOf('/');
  return index === -1 ? '' : id.slice(0, index);
}

export function joinId(parentId: string, name: string): string {
  return parentId === '' ? name : `${parentId}/${name}`;
}

/** True when `id` equals `ancestorId` or lies inside it. */
export function isSameOrDescendant(id: string, ancestorId: string): boolean {
  if (ancestorId === '') return true;
  return id === ancestorId || id.startsWith(`${ancestorId}/`);
}

/** Marker between the original name and the timestamp of a soft-deleted node folder. */
export const DELETED_MARKER = '.deleted-';

/**
 * Soft-deleted folder name (one segment): `<name>.deleted-<epochMs>[-<n>]`.
 * The `.` makes it a non-slug, so it never collides with a live node name.
 */
export const DELETED_NAME_RE =
  /^(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)\.deleted-(?<ts>\d{13,})(?:-(?<n>[2-9]|[1-9]\d+))?$/;

/** Glob that matches any path inside a soft-deleted folder (agent deny rules). */
export const DELETED_PATH_GLOB = '**/*.deleted-*/**';

export function isDeletedName(name: string): boolean {
  return DELETED_NAME_RE.test(name);
}

/** Trash folder name for `name`; `counter >= 2` adds the disambiguation suffix. */
export function deletedNameFor(name: string, now = Date.now(), counter = 1): string {
  const base = `${name}${DELETED_MARKER}${now}`;
  return counter >= 2 ? `${base}-${counter}` : base;
}

/** Parsed trash id: `<live parent node id>/<deleted folder name>`. */
export interface ParsedTrashId {
  /** Live parent node id (`""` = tree root). */
  parentId: string;
  /** Deleted folder name, e.g. `borrowing-rules.deleted-1759000000000`. */
  folder: string;
  /** Original slug, the desired name on restore. */
  originalName: string;
  /** Deletion time, epoch ms. */
  deletedAt: number;
}

export function parseTrashId(trashId: string): ParsedTrashId {
  if (trashId === '' || path.isAbsolute(trashId) || trashId.includes('\\')) {
    throw new InvalidInputError(`Invalid trash id: ${trashId}`);
  }
  const index = trashId.lastIndexOf('/');
  const parentId = index === -1 ? '' : trashId.slice(0, index);
  const folder = trashId.slice(index + 1);
  const match = DELETED_NAME_RE.exec(folder);
  if (!match?.groups) throw new InvalidInputError(`Invalid trash id: ${trashId}`);
  try {
    nodeIdSegments(parentId);
  } catch {
    throw new InvalidInputError(`Invalid trash id: ${trashId}`);
  }
  const originalName = match.groups.name ?? '';
  if (reservedNamesFor(parentId).has(originalName)) {
    throw new InvalidInputError(`Invalid trash id: ${trashId}`);
  }
  return { parentId, folder, originalName, deletedAt: Number(match.groups.ts) };
}

export function trashDirOf(treeDir: string, trashId: string): string {
  const { parentId, folder } = parseTrashId(trashId);
  return resolveInside(treeDir, ...nodeIdSegments(parentId), folder);
}
