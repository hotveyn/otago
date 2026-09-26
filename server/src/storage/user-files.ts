// Constants mirror .claude/features/chat-file-attachments/contracts/user-files.ts
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidInputError, UploadError } from '../errors.js';
import {
  ATTACHMENT_NAME_PATTERN,
  type AttachmentKind,
  attachmentContentTypeOf,
  attachmentKindOf,
  cleanFileStem,
} from './attachments.js';
import {
  ebookContentType,
  ebookExtensionOf,
  ebookTextName,
  extractEbookText,
} from './ebooks/index.js';
import { isErrno, uniqueFileName } from './fs-utils.js';
import { nodeDirOf, resolveInside, USER_FILES_DIR } from './paths.js';
import { MAX_SOURCE_BYTES } from './sources.js';

/** Max user files per message. */
export const MAX_MESSAGE_FILES = 10;

/** Per-file cap in bytes (same as the sources cap). */
export const MAX_MESSAGE_FILE_BYTES = MAX_SOURCE_BYTES;

/** Allowed extensions (lowercase, with dot); matched case-insensitively by longest suffix. */
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

export const MESSAGE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

/** Used only when the filename has no allowed extension (e.g. a nameless clipboard image). */
export const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, MessageFileExtension>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Stem used when the uploaded image name has no usable stem. */
export const DEFAULT_PASTED_STEM = 'pasted-image';
const DEFAULT_FILE_STEM = 'file';

/** Stored names always match this pattern (and never contain `..`). */
export const USER_FILE_NAME_PATTERN = ATTACHMENT_NAME_PATTERN;

const MAX_NAME_LENGTH = 120;
const PART_PREFIX = '.part-';
const MB = 1024 * 1024;

/** Longest first, so `.fb2.zip` wins over any shorter suffix. */
const BY_LENGTH = [...MESSAGE_FILE_EXTENSIONS].sort((a, b) => b.length - a.length);

/** One user file of a node, as returned in `ChainNode.files` and `done.files`. */
export interface UserFileInfo {
  name: string;
  /** Size in bytes of the original file. */
  size: number;
  contentType: string;
  kind: AttachmentKind;
  /** E-books only: the extracted-text companion `<name>.md` in the same folder. */
  text?: string;
}

/** One readable file line in the agent prompt. Paths are relative to the tree folder. */
export interface PromptFile {
  /** Path the agent should Read: the file itself, or for e-books the `.md` companion. */
  path: string;
  /** Stored name. */
  name: string;
  kind: AttachmentKind;
  size: number;
  /** E-books: the book file the companion was extracted from. */
  bookOf?: string;
}

/** Allowed extension of `name` (lowercase, with dot), by longest suffix. */
export function userFileExtensionOf(name: string): MessageFileExtension | undefined {
  const lower = name.toLowerCase();
  return BY_LENGTH.find((ext) => lower.endsWith(ext));
}

function isImageExtension(ext: string): boolean {
  return (MESSAGE_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

function unsupported(original: string): UploadError {
  return new UploadError(
    `Unsupported file type "${original}". Allowed: ${MESSAGE_FILE_EXTENSIONS.join(', ')}`,
    'unsupported_file_type',
  );
}

/**
 * Split an uploaded filename into a raw stem and an allowed extension. The declared MIME type
 * is used only for images, when the name itself has no allowed extension.
 */
export function resolveUserFileName(
  filename: string,
  mimetype: string,
): { stem: string; ext: MessageFileExtension } {
  const base = (filename.split(/[/\\]/).at(-1) ?? '').trim();
  const ext = userFileExtensionOf(base);
  if (ext) return { stem: base.slice(0, base.length - ext.length), ext };
  const fromMime = IMAGE_MIME_EXTENSIONS[mimetype.toLowerCase().split(';')[0]?.trim() ?? ''];
  if (fromMime) {
    const dot = base.lastIndexOf('.');
    return { stem: dot > 0 ? base.slice(0, dot) : dot === 0 ? '' : base, ext: fromMime };
  }
  throw unsupported(filename || 'unnamed file');
}

/** Safe stored name for `stem` + `ext`; always matches `USER_FILE_NAME_PATTERN`. */
export function userFileName(stem: string, ext: string): string {
  // E-books keep room for the `.md` companion.
  const room =
    MAX_NAME_LENGTH - ext.length - (ebookExtensionOf(ext) ? ebookTextName('').length : 0);
  const cleaned = cleanFileStem(stem).slice(0, room).replace(/\.+$/, '');
  const fallback = isImageExtension(ext) ? DEFAULT_PASTED_STEM : DEFAULT_FILE_STEM;
  const name = `${cleaned || fallback}${ext}`;
  if (!isUserFileName(name)) throw new Error(`Could not build a safe file name for "${stem}"`);
  return name;
}

export function isUserFileName(name: string): boolean {
  return USER_FILE_NAME_PATTERN.test(name) && !name.includes('..');
}

export function assertUserFileName(name: string): void {
  if (!isUserFileName(name)) throw new InvalidInputError(`Invalid file name: ${name}`);
}

export function userFileContentTypeOf(name: string): string {
  return ebookContentType(name) ?? attachmentContentTypeOf(name);
}

export function userFileKindOf(name: string): AttachmentKind {
  return attachmentKindOf(name);
}

function infoOf(name: string, size: number, text?: string): UserFileInfo {
  return {
    name,
    size,
    contentType: userFileContentTypeOf(name),
    kind: userFileKindOf(name),
    ...(text && { text }),
  };
}

/** Absolute path of a committed user file. Validates the node id and the name. */
export function userFilePath(treeDir: string, nodeId: string, name: string): string {
  assertUserFileName(name);
  return resolveInside(nodeDirOf(treeDir, nodeId), USER_FILES_DIR, name);
}

/**
 * Files in `<nodeDir>/files/`, sorted by name (ASCII). E-book companions are folded into
 * `text`. `[]` when the folder is missing.
 */
export async function listUserFiles(nodeDir: string): Promise<UserFileInfo[]> {
  const dir = path.join(nodeDir, USER_FILES_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return [];
    throw error;
  });
  const names = new Set(
    entries.filter((entry) => entry.isFile() && isUserFileName(entry.name)).map((e) => e.name),
  );
  const texts = new Set(
    [...names]
      .filter((name) => ebookExtensionOf(name))
      .map(ebookTextName)
      .filter((name) => names.has(name)),
  );
  const result: UserFileInfo[] = [];
  for (const name of names) {
    if (texts.has(name)) continue;
    const info = await stat(path.join(dir, name));
    const text = ebookTextName(name);
    result.push(infoOf(name, info.size, texts.has(text) ? text : undefined));
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function promptFileOf(folder: string, file: UserFileInfo): PromptFile {
  if (file.text) {
    return {
      path: `${folder}/${file.text}`,
      name: file.name,
      kind: 'text',
      size: file.size,
      bookOf: file.name,
    };
  }
  return { path: `${folder}/${file.name}`, name: file.name, kind: file.kind, size: file.size };
}

/** Prompt lines for the files of a committed chain node. */
export function nodePromptFiles(nodeId: string, files: UserFileInfo[]): PromptFile[] {
  return files.map((file) => promptFileOf(`${nodeId}/${USER_FILES_DIR}`, file));
}

interface Signature {
  label: string;
  matches: (head: Buffer) => boolean;
}

const ascii = (head: Buffer, offset: number, text: string) =>
  head.subarray(offset, offset + text.length).toString('latin1') === text;

const SIGNATURES: Record<string, Signature> = {
  '.png': {
    label: 'PNG',
    matches: (h) =>
      h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  '.jpg': {
    label: 'JPEG',
    matches: (h) => h.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
  '.jpeg': {
    label: 'JPEG',
    matches: (h) => h.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
  '.gif': { label: 'GIF', matches: (h) => ascii(h, 0, 'GIF87a') || ascii(h, 0, 'GIF89a') },
  '.webp': { label: 'WEBP', matches: (h) => ascii(h, 0, 'RIFF') && ascii(h, 8, 'WEBP') },
  '.pdf': { label: 'PDF', matches: (h) => ascii(h, 0, '%PDF-') },
};

/** Magic-byte check for images and PDFs. Other types are not sniffed. */
export function checkSignature(ext: string, head: Buffer, original: string): void {
  const signature = SIGNATURES[ext];
  if (signature && !signature.matches(head)) {
    throw new UploadError(
      `"${original}" is not a valid ${signature.label} file`,
      'unreadable_file',
    );
  }
}

async function readHead(file: string, length = 12): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Collects the user files of one message into `<stagingDir>/files/`. */
export interface UserFileStager {
  /**
   * Validate and stage one uploaded file. The type is checked before any byte is read; on
   * rejection the stream is left unconsumed (the caller drains it).
   */
  addFromStream(input: {
    filename: string;
    mimetype: string;
    stream: Readable & { truncated?: boolean };
  }): Promise<UserFileInfo>;
  // Seam for attach-from-URL: `addFromUrl` = `downloadToFile(<dir>/.part-…)` + the shared
  // `commitPart` below, counted against MAX_MESSAGE_FILES.
  /** Staged files in arrival order. */
  list(): UserFileInfo[];
  /** Prompt lines for the staged files, relative to `treeDir` (POSIX separators). */
  promptFiles(treeDir: string): PromptFile[];
}

export interface UserFileStagerOptions {
  /** Answer staging folder; files go to `<stagingDir>/files/`. */
  stagingDir: string;
  signal: AbortSignal;
  /** Per-file cap override (tests). */
  maxFileBytes?: number;
}

export function createUserFileStager(options: UserFileStagerOptions): UserFileStager {
  const dir = path.join(options.stagingDir, USER_FILES_DIR);
  const maxBytes = options.maxFileBytes ?? MAX_MESSAGE_FILE_BYTES;
  const taken = new Set<string>();
  const files: UserFileInfo[] = [];
  let count = 0;

  /** Steps shared by every producer: validate the `.part-` file, name it, rename, extract. */
  async function commitPart(
    partPath: string,
    original: string,
    stem: string,
    ext: MessageFileExtension,
    truncated: boolean,
  ): Promise<UserFileInfo> {
    const created: string[] = [];
    try {
      if (truncated) {
        throw new UploadError(
          `"${original}" is larger than ${Math.round(maxBytes / MB)} MB`,
          'file_too_large',
        );
      }
      const { size } = await stat(partPath);
      if (size === 0) throw new UploadError(`"${original}" is empty`, 'empty_file');
      checkSignature(ext, await readHead(partPath), original);

      const ebook = Boolean(ebookExtensionOf(ext));
      const maxLength = ebook ? MAX_NAME_LENGTH - ebookTextName('').length : MAX_NAME_LENGTH;
      const base = userFileName(stem, ext);
      const skip = new Set(taken);
      let name = uniqueFileName(skip, base, maxLength, ext);
      while (ebook && skip.has(ebookTextName(name))) {
        skip.add(name);
        name = uniqueFileName(skip, base, maxLength, ext);
      }
      const text = ebook ? ebookTextName(name) : undefined;
      taken.add(name);
      if (text) taken.add(text);

      const target = path.join(dir, name);
      created.push(target);
      await rename(partPath, target);
      if (text) {
        let markdown: string;
        try {
          markdown = extractEbookText(name, await readFile(target), `${USER_FILES_DIR}/${name}`);
        } catch (error) {
          if (!(error instanceof InvalidInputError)) throw error;
          const prefix = `Cannot read ${name}`;
          const message = error.message.startsWith(prefix)
            ? `Cannot read ${original}${error.message.slice(prefix.length)}`
            : error.message;
          throw new UploadError(message, 'unreadable_file');
        }
        const companion = path.join(dir, text);
        created.push(companion);
        await writeFile(companion, markdown, 'utf8');
      }
      const info = infoOf(name, size, text);
      files.push(info);
      return info;
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined);
      for (const file of created) await rm(file, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  return {
    async addFromStream({ filename, mimetype, stream }) {
      const original = filename || 'unnamed file';
      if (count >= MAX_MESSAGE_FILES) {
        throw new UploadError(
          `Too many files: at most ${MAX_MESSAGE_FILES} per message`,
          'too_many_files',
        );
      }
      const { stem, ext } = resolveUserFileName(filename, mimetype);
      count++;
      await mkdir(dir, { recursive: true });
      const partPath = path.join(dir, `${PART_PREFIX}${randomUUID()}`);
      try {
        await pipeline(stream, createWriteStream(partPath), { signal: options.signal });
      } catch (error) {
        await rm(partPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return commitPart(partPath, original, stem, ext, stream.truncated === true);
    },

    list() {
      return [...files];
    },

    promptFiles(treeDir) {
      const folder = path.relative(treeDir, dir).split(path.sep).join('/');
      return files.map((file) => promptFileOf(folder, file));
    },
  };
}
