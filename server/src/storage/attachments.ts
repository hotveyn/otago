import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AttachmentError, InvalidInputError } from '../errors.js';
import { type DownloadOptions, downloadToFile, extensionForContentType } from './download.js';
import { isErrno, uniqueFileName } from './fs-utils.js';
import { ATTACHMENTS_DIR, nodeDirOf, resolveInside, STAGING_PREFIX } from './paths.js';

/** Preview category, derived from the file extension. */
export type AttachmentKind = 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other';

/** Where an attachment came from; only known while the answer is generated. */
export type AttachmentOrigin = 'inline' | 'url' | 'sandbox';

export interface AttachmentInfo {
  name: string;
  size: number;
  contentType: string;
  kind: AttachmentKind;
  /** Present only in streaming events. */
  origin?: AttachmentOrigin;
}

/** Lifecycle of one save. Order per key: `saving` → (`ready` | `failed`). */
export type AttachmentEvent =
  | { status: 'saving'; key: string; requestedName?: string; origin: AttachmentOrigin }
  | { status: 'ready'; key: string; attachment: AttachmentInfo }
  | { status: 'failed'; key: string; requestedName?: string; message: string };

/** Final attachment names always match this pattern (and never contain `..`). */
export const ATTACHMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
export const ATTACHMENT_LINK_PREFIX = `${ATTACHMENTS_DIR}/`;

const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;
const PART_PREFIX = '.part-';

interface TypeEntry {
  kind: AttachmentKind;
  type: string;
}

const TEXT_EXTENSIONS = [
  'txt',
  'yaml',
  'yml',
  'toml',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'scala',
  'swift',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'sql',
  'ini',
  'cfg',
  'conf',
  'env',
  'log',
  'diff',
  'patch',
  'lua',
  'r',
  'jl',
  'hs',
  'ex',
  'exs',
  'erl',
  'clj',
  'dart',
  'vue',
  'svelte',
  'scss',
  'less',
  'graphql',
  'proto',
  'tex',
  'rst',
  'adoc',
  'mermaid',
  'mmd',
] as const;

const TYPES: Record<string, TypeEntry> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  avif: { kind: 'image', type: 'image/avif' },
  bmp: { kind: 'image', type: 'image/bmp' },
  ico: { kind: 'image', type: 'image/x-icon' },
  svg: { kind: 'svg', type: 'image/svg+xml' },
  csv: { kind: 'table', type: 'text/csv' },
  tsv: { kind: 'table', type: 'text/tab-separated-values' },
  md: { kind: 'text', type: 'text/markdown' },
  json: { kind: 'text', type: 'application/json' },
  xml: { kind: 'text', type: 'text/xml' },
  html: { kind: 'text', type: 'text/html' },
  htm: { kind: 'text', type: 'text/html' },
  css: { kind: 'text', type: 'text/css' },
  ...Object.fromEntries(TEXT_EXTENSIONS.map((ext) => [ext, { kind: 'text', type: 'text/plain' }])),
  pdf: { kind: 'pdf', type: 'application/pdf' },
  zip: { kind: 'other', type: 'application/zip' },
  gz: { kind: 'other', type: 'application/gzip' },
  tar: { kind: 'other', type: 'application/x-tar' },
  mp3: { kind: 'other', type: 'audio/mpeg' },
  wav: { kind: 'other', type: 'audio/wav' },
  mp4: { kind: 'other', type: 'video/mp4' },
  webm: { kind: 'other', type: 'video/webm' },
  docx: {
    kind: 'other',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    kind: 'other',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pptx: {
    kind: 'other',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

function typeEntryOf(name: string): TypeEntry | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
}

export function attachmentKindOf(name: string): AttachmentKind {
  return typeEntryOf(name)?.kind ?? 'other';
}

/** MIME type the file is served with. Text-like types carry `; charset=utf-8`. */
export function attachmentContentTypeOf(name: string): string {
  const type = typeEntryOf(name)?.type ?? 'application/octet-stream';
  return type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type;
}

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  const ext = name.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '');
  if (!ext || ext.length > MAX_EXTENSION_LENGTH) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext };
}

function cleanStem(stem: string): string {
  return stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/\.+$/, '');
}

/** Safe file name for `attachments/`; always matches `ATTACHMENT_NAME_PATTERN`. */
export function sanitizeAttachmentName(raw: string, fallback = 'attachment'): string {
  const base = raw.split(/[/\\]/).at(-1) ?? '';
  const { stem, ext } = splitExtension(base.trim());
  const suffix = ext ? `.${ext}` : '';
  const cleaned = cleanStem(stem)
    .slice(0, MAX_NAME_LENGTH - suffix.length)
    .replace(/\.+$/, '');
  const result = `${cleaned || cleanStem(fallback) || 'attachment'}${suffix}`;
  return ATTACHMENT_NAME_PATTERN.test(result) && !result.includes('..') ? result : 'attachment';
}

export function isAttachmentName(name: string): boolean {
  return ATTACHMENT_NAME_PATTERN.test(name) && !name.includes('..');
}

export function assertAttachmentName(name: string): void {
  if (!isAttachmentName(name)) throw new InvalidInputError(`Invalid attachment name: ${name}`);
}

/** Absolute path of a committed attachment. Validates the node id and the name. */
export function attachmentPath(treeDir: string, nodeId: string, name: string): string {
  assertAttachmentName(name);
  return resolveInside(nodeDirOf(treeDir, nodeId), ATTACHMENTS_DIR, name);
}

function infoOf(name: string, size: number): AttachmentInfo {
  return {
    name,
    size,
    contentType: attachmentContentTypeOf(name),
    kind: attachmentKindOf(name),
  };
}

/** Files in `<nodeDir>/attachments/`, sorted by name (ASCII). `[]` when the folder is missing. */
export async function listAttachments(nodeDir: string): Promise<AttachmentInfo[]> {
  const dir = path.join(nodeDir, ATTACHMENTS_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return [];
    throw error;
  });
  const result: AttachmentInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isAttachmentName(entry.name)) continue;
    const info = await stat(path.join(dir, entry.name));
    result.push(infoOf(entry.name, info.size));
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Producer-facing staging API: the agent tool today, a sandbox later. */
export interface AttachmentStaging {
  saveFromBytes(input: {
    name: string;
    data: Uint8Array;
    origin: AttachmentOrigin;
  }): Promise<AttachmentInfo>;
  saveFromUrl(input: { url: string; name?: string }): Promise<AttachmentInfo>;
  saveFromStream(input: {
    name: string;
    stream: Readable;
    origin: AttachmentOrigin;
  }): Promise<AttachmentInfo>;
}

/** Staging folder of one answer; becomes the node folder on commit. */
export interface AnswerStaging extends AttachmentStaging {
  readonly dir: string;
  /** Staged attachments (no `origin`). */
  list(): Promise<AttachmentInfo[]>;
  /** Stop accepting saves, wait for in-flight ones, drop an empty `attachments/`. */
  seal(): Promise<void>;
  /** Remove the staging folder. Idempotent. */
  discard(): Promise<void>;
}

export interface AnswerStagingOptions {
  /** Folder of the parent node; the staging folder is created inside it. */
  parentDir: string;
  signal: AbortSignal;
  onEvent?: (event: AttachmentEvent) => void;
  allowPrivateUrls?: boolean;
  /** Downloader override for tests. */
  download?: (options: DownloadOptions) => ReturnType<typeof downloadToFile>;
}

export async function createAnswerStaging(options: AnswerStagingOptions): Promise<AnswerStaging> {
  const dir = await mkdtemp(path.join(options.parentDir, STAGING_PREFIX));
  const attachmentsDir = path.join(dir, ATTACHMENTS_DIR);
  const download = options.download ?? downloadToFile;
  const reserved = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let discarded = false;

  const emit = (event: AttachmentEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // A broken listener must not fail the save.
    }
  };

  const assertOpen = () => {
    if (options.signal.aborted) throw new AttachmentError('Aborted');
    if (closed) throw new AttachmentError('The answer is no longer accepting attachments');
  };

  /** Run one save: `saving` event, write to a `.part-` file, rename, `ready` / `failed`. */
  function track(
    requestedName: string | undefined,
    origin: AttachmentOrigin,
    write: (partPath: string, reserve: (requested: string) => string) => Promise<void>,
  ): Promise<AttachmentInfo> {
    const key = randomUUID();
    emit({ status: 'saving', key, requestedName, origin });
    let finalName: string | undefined;
    const partPath = path.join(attachmentsDir, `${PART_PREFIX}${key}`);
    const run = (async () => {
      try {
        assertOpen();
        await mkdir(attachmentsDir, { recursive: true });
        assertOpen();
        await write(partPath, (requested) => {
          finalName = uniqueFileName(reserved, sanitizeAttachmentName(requested));
          reserved.add(finalName);
          return finalName;
        });
        if (!finalName) throw new Error('No file name reserved');
        assertOpen();
        const target = path.join(attachmentsDir, finalName);
        await rename(partPath, target);
        const info = { ...infoOf(finalName, (await stat(target)).size), origin };
        emit({ status: 'ready', key, attachment: info });
        return info;
      } catch (error) {
        await rm(partPath, { force: true }).catch(() => undefined);
        if (finalName) {
          await rm(path.join(attachmentsDir, finalName), { force: true }).catch(() => undefined);
          reserved.delete(finalName);
        }
        const message =
          error instanceof AttachmentError
            ? error.message
            : `Could not save attachment: ${error instanceof Error ? error.message : String(error)}`;
        emit({ status: 'failed', key, requestedName, message });
        throw error instanceof AttachmentError ? error : new AttachmentError(message);
      }
    })();
    pending.add(run);
    void run.catch(() => undefined).finally(() => pending.delete(run));
    return run;
  }

  const writeStream = async (stream: Readable, partPath: string) => {
    await pipeline(stream, createWriteStream(partPath), { signal: options.signal });
  };

  return {
    dir,

    saveFromBytes({ name, data, origin }) {
      return track(name, origin, async (partPath, reserve) => {
        if (data.byteLength === 0) throw new AttachmentError('Empty content');
        reserve(name);
        await writeStream(Readable.from([Buffer.from(data)]), partPath);
      });
    },

    saveFromStream({ name, stream, origin }) {
      return track(name, origin, async (partPath, reserve) => {
        reserve(name);
        await writeStream(stream, partPath);
        if ((await stat(partPath)).size === 0) throw new AttachmentError('Empty content');
      });
    },

    saveFromUrl({ url, name }) {
      return track(name, 'url', async (partPath, reserve) => {
        const result = await download({
          url,
          target: partPath,
          signal: options.signal,
          allowPrivate: options.allowPrivateUrls ?? false,
        });
        let requested = sanitizeAttachmentName(name ?? result.suggestedName ?? '');
        if (!requested.includes('.')) {
          const ext = extensionForContentType(result.contentType);
          if (ext) requested = sanitizeAttachmentName(`${requested}${ext}`);
        }
        reserve(requested);
      });
    },

    async list() {
      return listAttachments(dir);
    },

    async seal() {
      closed = true;
      await Promise.allSettled([...pending]);
      await rmdir(attachmentsDir).catch(() => undefined);
    },

    async discard() {
      closed = true;
      await Promise.allSettled([...pending]);
      if (discarded) return;
      discarded = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Best-effort removal of staging folders left behind by a crash. */
export async function sweepStaleStaging(parentDir: string, maxAgeMs = 60 * 60 * 1000) {
  const entries = await readdir(parentDir, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
    const target = path.join(parentDir, entry.name);
    try {
      if ((await stat(target)).mtimeMs < cutoff) await rm(target, { recursive: true, force: true });
    } catch {
      // Ignore: another process may have removed it.
    }
  }
}
