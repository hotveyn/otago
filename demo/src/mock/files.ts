/**
 * File types and file names, ported from `server/src/storage/attachments.ts`,
 * `user-files.ts` and `sources.ts` (they import Node modules). E-books are not supported in
 * the demo: their conversion needs the server.
 */
import type { AttachmentInfo, AttachmentKind, UserFileInfo } from '../../../web/src/api/types';
import { badRequest } from './errors';

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
];

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
};

function typeEntryOf(name: string): TypeEntry | undefined {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
}

export function fileKindOf(name: string): AttachmentKind {
  return typeEntryOf(name)?.kind ?? 'other';
}

/** MIME type a node file is served with. Text-like types carry `; charset=utf-8`. */
export function fileContentTypeOf(name: string): string {
  const type = typeEntryOf(name)?.type ?? 'application/octet-stream';
  return type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type;
}

export function fileInfoOf(name: string, size: number): AttachmentInfo & UserFileInfo {
  return { name, size, contentType: fileContentTypeOf(name), kind: fileKindOf(name) };
}

/** Stored node file names (attachments and user files) always match this. */
export const NODE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function isNodeFileName(name: string): boolean {
  return NODE_FILE_NAME_PATTERN.test(name) && !name.includes('..');
}

// --- Sources -----------------------------------------------------------------------------

const SOURCE_EXTENSIONS = ['.md', '.txt', '.pdf'];
const EBOOK_EXTENSIONS = ['.fb2.zip', '.epub', '.fb2', '.mobi', '.azw', '.azw3'];
const SOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

const isEbook = (name: string) => EBOOK_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

export function isSourceName(name: string): boolean {
  return (
    SOURCE_NAME_RE.test(name) &&
    !name.includes('..') &&
    SOURCE_EXTENSIONS.includes(extensionOf(name))
  );
}

export function assertSourceName(name: string): void {
  if (!SOURCE_NAME_RE.test(name) || name.includes('..')) {
    throw badRequest(`Invalid source file name: ${name}`);
  }
  if (isEbook(name)) {
    throw badRequest(
      `E-books are not available in the demo: their text is extracted by the Otago server. Allowed here: ${SOURCE_EXTENSIONS.join(', ')}`,
    );
  }
  if (!SOURCE_EXTENSIONS.includes(extensionOf(name))) {
    throw badRequest(
      `Unsupported source type "${extensionOf(name) || name}". Allowed: ${SOURCE_EXTENSIONS.join(', ')}`,
    );
  }
}

export function sourceContentTypeOf(name: string): string {
  switch (extensionOf(name)) {
    case '.pdf':
      return 'application/pdf';
    case '.md':
      return 'text/markdown; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

// --- User files of a message ---------------------------------------------------------------

/** Max user files per message (as on the server). */
export const MAX_MESSAGE_FILES = 10;

/** Per-file cap of the demo: everything lives in localStorage (about 5 MB in total). */
export const DEMO_MAX_FILE_BYTES = 512 * 1024;

const MESSAGE_FILE_EXTENSIONS = ['.md', '.txt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const IMAGE_MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Safe-name rules for a file stem (may return `""`). */
function cleanFileStem(stem: string): string {
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

/**
 * Stored name for an uploaded file (`resolveUserFileName` + `userFileName` of the server), or
 * 400 `unsupported_file_type`.
 */
export function userFileNameOf(filename: string, mimetype: string): string {
  const base = (filename.split(/[/\\]/).at(-1) ?? '').trim();
  const lower = base.toLowerCase();
  let ext = MESSAGE_FILE_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  let stem = ext ? base.slice(0, base.length - ext.length) : '';
  if (!ext) {
    ext = IMAGE_MIME_EXTENSIONS[mimetype.toLowerCase().split(';')[0]?.trim() ?? ''];
    const dot = base.lastIndexOf('.');
    stem = dot > 0 ? base.slice(0, dot) : dot === 0 ? '' : base;
  }
  if (!ext) {
    const reason = isEbook(base) ? ' E-books are not available in the demo.' : '';
    throw badRequest(
      `Unsupported file type "${filename || 'unnamed file'}". Allowed: ${MESSAGE_FILE_EXTENSIONS.join(', ')}.${reason}`,
      'unsupported_file_type',
    );
  }
  const cleaned = cleanFileStem(stem)
    .slice(0, 120 - ext.length)
    .replace(/\.+$/, '');
  return `${cleaned || (IMAGE_EXTENSIONS.includes(ext) ? 'pasted-image' : 'file')}${ext}`;
}
