/**
 * Ids and names, as in `server/src/storage/paths.ts` (which imports `node:path`, so the pure
 * parts are ported here). Node-name rules come straight from the server module.
 */
import { isNodeName, nameKey } from '../../../server/src/storage/node-names';
import { badRequest } from './errors';

export { isNodeName, nameKey, toNodeName } from '../../../server/src/storage/node-names';

export const TREE_FILE = 'tree.md';
export const NODE_FILE = 'node.md';
export const SOURCES_DIR = 'sources';
export const ATTACHMENTS_DIR = 'attachments';
export const USER_FILES_DIR = 'files';

const RESERVED_NODE_NAMES: ReadonlySet<string> = new Set([ATTACHMENTS_DIR, USER_FILES_DIR]);
const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  TREE_FILE,
  SOURCES_DIR,
  ATTACHMENTS_DIR,
  USER_FILES_DIR,
]);

/** Reserved child names under `parentId` (`""` = tree root). Compare with `nameKey`. */
export function reservedNamesFor(parentId: string): ReadonlySet<string> {
  return parentId === '' ? RESERVED_ROOT_NAMES : RESERVED_NODE_NAMES;
}

export function isReservedName(parentId: string, name: string): boolean {
  return reservedNamesFor(parentId).has(nameKey(name));
}

const TREE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isTreeId(value: string): boolean {
  return TREE_ID_RE.test(value);
}

/** Tree id from a title: lowercase ASCII kebab-case, `fallback` when nothing is left. */
export function toTreeId(input: string, fallback = 'tree', maxLength = 60): string {
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

/** Validate a node id (`""` = root) and return its segments, or throw 400. */
export function nodeIdSegments(id: string): string[] {
  if (id === '') return [];
  const segments = id.split('/');
  for (const [index, segment] of segments.entries()) {
    const parentId = segments.slice(0, index).join('/');
    if (!isNodeName(segment) || isReservedName(parentId, segment)) {
      throw badRequest(`Invalid node id: ${id}`);
    }
  }
  return segments;
}

export function parentIdOf(id: string): string {
  const index = id.lastIndexOf('/');
  return index === -1 ? '' : id.slice(0, index);
}

export function lastSegment(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

export function joinId(parentId: string, name: string): string {
  return parentId === '' ? name : `${parentId}/${name}`;
}

/** True when `id` equals `ancestorId` or lies inside it. */
export function isSameOrDescendant(id: string, ancestorId: string): boolean {
  if (ancestorId === '') return true;
  return id === ancestorId || id.startsWith(`${ancestorId}/`);
}

const DELETED_MARKER = '.deleted-';

const DELETED_NAME_RE =
  /^(?<name>[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*)\.deleted-(?<ts>\d{13,})(?:-(?<n>[2-9]|[1-9]\d+))?$/u;

/** Trash folder name for `name`; `counter >= 2` adds the disambiguation suffix. */
export function deletedNameFor(name: string, now: number, counter = 1): string {
  const base = `${name}${DELETED_MARKER}${now}`;
  return counter >= 2 ? `${base}-${counter}` : base;
}

export interface ParsedTrashId {
  parentId: string;
  folder: string;
  originalName: string;
}

export function parseTrashId(trashId: string): ParsedTrashId {
  const invalid = () => badRequest(`Invalid trash id: ${trashId}`);
  if (trashId === '' || trashId.startsWith('/') || trashId.includes('\\')) throw invalid();
  const index = trashId.lastIndexOf('/');
  const parentId = index === -1 ? '' : trashId.slice(0, index);
  const folder = trashId.slice(index + 1);
  const originalName = DELETED_NAME_RE.exec(folder)?.groups?.name;
  if (originalName === undefined) throw invalid();
  try {
    nodeIdSegments(parentId);
  } catch {
    throw invalid();
  }
  if (!isNodeName(originalName) || isReservedName(parentId, originalName)) throw invalid();
  return { parentId, folder, originalName };
}

/**
 * First free name among `base`, `base-2`, `base-3`, … whose `nameKey` is not taken by
 * `existing` (except `self`, which counts as free) or `reserved`.
 */
export function uniqueName(
  base: string,
  existing: readonly string[],
  reserved: ReadonlySet<string> = new Set(),
  self?: string,
): string {
  const taken = new Set(existing.map(nameKey));
  if (self !== undefined) taken.delete(nameKey(self));
  for (const name of reserved) taken.add(nameKey(name));
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

/**
 * First free file name among `name`, `stem-2.ext`, `stem-3.ext`, … (suffix before the last
 * extension). As `uniqueFileName` in `server/src/storage/fs-utils.ts`.
 */
export function uniqueFileName(taken: ReadonlySet<string>, name: string, maxLength = 120): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const room = Math.max(1, maxLength - suffix.length - ext.length);
    const candidate = `${stem.slice(0, room)}${suffix}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
