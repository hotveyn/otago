/**
 * CONTRACT SPEC (planning artifact) — feature `chat-file-attachments`.
 * Owner: server. Consumers: web (mirrors the constants/types by hand in `web/src/lib/chat-files.ts`
 * and `web/src/api/types.ts`). Interfaces / types / constants only. Not a runtime module.
 *
 * User files = files the USER attached to a chat message. They belong to the node created by that
 * message and are stored as plain files in `<tree>/<node-path>/files/<name>`.
 * They are distinct from agent-generated `attachments/` (see feature `rich-answers`):
 * separate folder, separate chain field, separate URL, never mixed.
 * No sidecar metadata; everything is derived from the file name + `stat`.
 */
import type { AttachmentKind } from './shared';

/**
 * DECISION (open question "folder name"): `files`.
 * - Folder inside a node folder: `<node>/files/`.
 * - Reserved at every node level AND at the tree root (joins `attachments` in
 *   `RESERVED_NODE_NAMES` / `RESERVED_ROOT_NAMES`): no node can be named `files`; a node id
 *   segment `files` is invalid; the hierarchy reader skips a `files` folder.
 * - Never collides with agent `attachments/` (different folder), so user `a.png` and agent
 *   `a.png` can coexist in one node.
 * Compatibility note: a pre-existing node folder literally named `files` becomes hidden/invalid
 * (same trade-off `attachments` made). Naming produces 2–4 word slugs, so this is unlikely.
 */
export const USER_FILES_DIR = 'files';

/** Max user files per message (picker + paste + drop combined; later also URLs). */
export const MAX_MESSAGE_FILES = 10;

/** Per-file cap in bytes. Equals the sources cap `MAX_SOURCE_BYTES` (20 MiB). */
export const MAX_MESSAGE_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Allowed extensions (lowercase, with dot). Matching is case-insensitive LONGEST-SUFFIX:
 * `.fb2.zip` is listed first and wins over anything shorter; a plain `x.zip` is NOT allowed.
 * = sources set (`.md .txt .pdf` + e-books) + images.
 * Web note: do not put `.fb2.zip` into `<input accept>` (browser bug with compound extensions);
 * use `.zip` there and validate with this list.
 */
export const MESSAGE_FILE_EXTENSIONS = [
  '.fb2.zip',
  '.md',
  '.txt',
  '.pdf',
  '.epub',
  '.fb2',
  '.mobi',
  '.azw',
  '.azw3',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
] as const;
export type MessageFileExtension = (typeof MESSAGE_FILE_EXTENSIONS)[number];

/** E-book subset: saved together with an extracted-text companion `<name>.md`. */
export const MESSAGE_EBOOK_EXTENSIONS = [
  '.fb2.zip',
  '.epub',
  '.fb2',
  '.mobi',
  '.azw',
  '.azw3',
] as const;

/** Image subset. The server checks the magic bytes of images (and PDFs) before accepting. */
export const MESSAGE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

/**
 * Used ONLY when a part's filename has no allowed extension (e.g. a nameless clipboard image):
 * the declared part MIME type picks the extension. The content is still checked by magic bytes.
 * Any other MIME type never makes a file acceptable.
 */
export const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, MessageFileExtension>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Stem used when the uploaded filename has no usable stem (e.g. `""`, `.png`, `🖼.png`). */
export const DEFAULT_PASTED_STEM = 'pasted-image';

/**
 * Stored names always match this pattern (same safe-name rule as agent attachments):
 * starts with `[A-Za-z0-9]`, then `[A-Za-z0-9._-]`, max 120 chars, never contains `..`.
 * Naming algorithm (server, authoritative):
 *   1. take the basename after the last `/` or `\`;
 *   2. split off the allowed extension by longest suffix (or derive it from IMAGE_MIME_EXTENSIONS);
 *      the stored extension is lowercased (`Photo.PNG` → `Photo.png`);
 *   3. NFKD, strip diacritics, whitespace → `-`, drop other chars, collapse `..`/`--`,
 *      trim leading `._-`; empty → DEFAULT_PASTED_STEM (images) or `file`;
 *   4. truncate the stem so the full name fits 120 chars; for e-books so that the companion
 *      `<name>.md` also fits 120 chars;
 *   5. make unique within the message: `stem-2.ext`, `stem-3.ext`, … with the suffix BEFORE the
 *      full (possibly compound) extension (`book.fb2.zip` → `book-2.fb2.zip`); e-book companions
 *      count as taken names.
 * The UI must display the server's name (from `done.files` / chain), never the local name.
 */
export const USER_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * One user file of a node, as returned in `ChainNode.files` and `done.files`.
 * Superset of the rich-answers `AttachmentInfo` (no `origin`), so the web can reuse its
 * attachment card with a `folder: 'files'` location.
 */
export interface UserFileInfo {
  /** Stored file name inside `<node>/files/` (sanitized, unique within the node). */
  name: string;
  /** Size in bytes of the original file. */
  size: number;
  /**
   * MIME type the file is served with. E-books: `application/epub+zip`,
   * `application/x-fictionbook+xml`, `application/zip` (.fb2.zip),
   * `application/x-mobipocket-ebook`, `application/vnd.amazon.ebook`;
   * otherwise the attachment MIME table (`text/markdown; charset=utf-8`, `image/png`, …).
   */
  contentType: string;
  /** Preview category (attachment kind table): images → `image`, `.md/.txt` → `text`,
   *  `.pdf` → `pdf`, e-books → `other` (download only). */
  kind: AttachmentKind;
  /**
   * E-books only: name of the extracted-text companion in the same folder (`<name>.md`).
   * The companion is NOT listed as a separate entry; it is fetchable via the files route.
   */
  text?: string;
}

/**
 * Listing rules for `<node>/files/` (used by chain and `done`):
 * regular files matching USER_FILE_NAME_PATTERN only; companions of listed e-books are folded
 * into `text`; sorted by name (ASCII). Missing folder → `[]` (all pre-existing nodes).
 */
export type UserFileList = UserFileInfo[];
