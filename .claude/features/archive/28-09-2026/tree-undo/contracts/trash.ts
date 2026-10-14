/**
 * tree-undo — contract spec: soft-delete ("virtual trash") naming.
 *
 * PLANNING ARTIFACT. Hand-authored spec, not production code. The implementer mirrors these
 * constants in `server/src/storage/paths.ts` (server) and, where needed, in `web/src/lib/*` (web).
 *
 * A soft-deleted node is its original folder renamed IN PLACE (same parent folder) to:
 *
 *     <name>.deleted-<epochMs>          e.g.  borrowing-rules.deleted-1759000000000
 *     <name>.deleted-<epochMs>-<n>      (n >= 2) only if that exact name already exists
 *
 * - `<name>` is the original folder name (a slug, see `isSlug`).
 * - `<epochMs>` is `Date.now()` at delete time, decimal, no padding (13+ digits).
 * - The `.` makes the whole name a NON-slug (`isSlug` rejects `.`), so it can never be produced
 *   by `toKebabCase`, never equals a live sibling name, and is already skipped by
 *   `readHierarchy` / rejected by `nodeIdSegments`. No `-2` collision with live nodes is possible.
 * - Children of a soft-deleted node stay inside it untouched (their folder names are unchanged).
 * - A purge (future) finds trash by `DELETED_NAME_RE` alone; no index file exists.
 */

/** Marker between the original name and the timestamp. */
export const DELETED_MARKER = '.deleted-';

/**
 * Matches a soft-deleted folder name (one path segment).
 * Groups: `name` = original slug, `ts` = epoch ms, `n` = optional disambiguation counter.
 */
export const DELETED_NAME_RE =
  /^(?<name>[a-z0-9]+(?:-[a-z0-9]+)*)\.deleted-(?<ts>\d{13,})(?:-(?<n>[2-9]|[1-9]\d+))?$/;

/** Glob that matches any path inside a soft-deleted folder (used for agent deny rules). */
export const DELETED_PATH_GLOB = '**/*.deleted-*/**';

/**
 * Identifier of one soft-deleted node, returned by delete and accepted by restore.
 *
 * It is the path of the trash folder relative to the tree folder:
 *   `<live parent node id>/<deleted folder name>`  or  `<deleted folder name>` at the root.
 *   e.g. `ownership/borrowing-rules.deleted-1759000000000`
 *
 * Because the prefix is the live parent node id, a later move/rename of an ancestor changes a
 * TrashId by the SAME prefix rewrite as node ids (`old/…` → `new/…`). The web history remaps
 * TrashIds with the same function it uses for node ids.
 *
 * Validation on the server: all segments but the last must form a valid live node id
 * (`nodeIdSegments`), the last segment must match `DELETED_NAME_RE`.
 */
export type TrashId = string;

/** Parsed TrashId (server helper `parseTrashId`, shape only). */
export interface ParsedTrashId {
  /** Live parent node id (`""` = tree root). */
  parentId: string;
  /** Deleted folder name, e.g. `borrowing-rules.deleted-1759000000000`. */
  folder: string;
  /** Original slug, e.g. `borrowing-rules`. Desired name on restore. */
  originalName: string;
  /** Deletion time, epoch ms. */
  deletedAt: number;
}
