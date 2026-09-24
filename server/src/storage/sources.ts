import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { InvalidInputError, NotFoundError } from '../errors.js';
import {
  EBOOK_EXTENSIONS,
  ebookContentType,
  ebookExtensionOf,
  ebookTextName,
  extractEbookText,
} from './ebooks/index.js';
import { isErrno, writeFileAtomic } from './fs-utils.js';
import { resolveInside, SOURCES_DIR } from './paths.js';

export const TEXT_SOURCE_EXTENSIONS = ['.md', '.txt', '.pdf'] as const;
export const SOURCE_EXTENSIONS = [...TEXT_SOURCE_EXTENSIONS, ...EBOOK_EXTENSIONS];

const SOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;

export interface SourceInfo {
  name: string;
  size: number;
  /** E-books only: the Markdown source with the extracted text (`<name>.md`). */
  text?: string;
}

export function contentTypeOf(name: string): string {
  const ebook = ebookContentType(name);
  if (ebook) return ebook;
  switch (path.extname(name).toLowerCase()) {
    case '.pdf':
      return 'application/pdf';
    case '.md':
      return 'text/markdown; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

export function assertSourceName(name: string): void {
  if (!SOURCE_NAME_RE.test(name) || name.includes('..')) {
    throw new InvalidInputError(`Invalid source file name: ${name}`);
  }
  if (ebookExtensionOf(name)) {
    // The extracted text must be a valid source name too.
    if (!SOURCE_NAME_RE.test(ebookTextName(name))) {
      throw new InvalidInputError(`Source file name is too long: ${name}`);
    }
    return;
  }
  const ext = path.extname(name).toLowerCase();
  if (!(TEXT_SOURCE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new InvalidInputError(
      `Unsupported source type "${ext || name}". Allowed: ${SOURCE_EXTENSIONS.join(', ')}`,
    );
  }
}

function sourcePath(treeDir: string, name: string): string {
  assertSourceName(name);
  return resolveInside(treeDir, SOURCES_DIR, name);
}

export async function listSources(treeDir: string): Promise<SourceInfo[]> {
  const dir = path.join(treeDir, SOURCES_DIR);
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const books = [...files].filter((name) => ebookExtensionOf(name));
  const texts = new Set(books.map(ebookTextName).filter((name) => files.has(name)));
  const sources: SourceInfo[] = [];
  for (const name of files) {
    // Extracted texts are listed on their book.
    if (texts.has(name)) continue;
    try {
      assertSourceName(name);
    } catch {
      continue;
    }
    const info = await stat(path.join(dir, name));
    const text = ebookTextName(name);
    sources.push({ name, size: info.size, ...(texts.has(text) && { text }) });
  }
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSource(treeDir: string, name: string): Promise<Buffer> {
  try {
    return await readFile(sourcePath(treeDir, name));
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'EISDIR')) throw new NotFoundError(`Source not found: ${name}`);
    throw error;
  }
}

/**
 * Save (or replace) a source file.
 * An e-book is saved with its text extracted to `<name>.md`, so the agent can search and cite it.
 */
export async function saveSource(
  treeDir: string,
  name: string,
  content: Uint8Array,
): Promise<SourceInfo> {
  const target = sourcePath(treeDir, name);
  const text = ebookExtensionOf(name) ? ebookTextName(name) : undefined;
  const markdown = text ? extractEbookText(name, content) : undefined;
  await mkdir(path.dirname(target), { recursive: true });
  if (text && markdown !== undefined) {
    await writeFileAtomic(sourcePath(treeDir, text), markdown);
  }
  await writeFileAtomic(target, content);
  return { name, size: content.byteLength, ...(text && { text }) };
}

/** Delete a source file; an e-book goes together with its extracted text. */
export async function deleteSource(treeDir: string, name: string): Promise<void> {
  try {
    await rm(sourcePath(treeDir, name));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new NotFoundError(`Source not found: ${name}`);
    throw error;
  }
  if (ebookExtensionOf(name)) {
    await rm(sourcePath(treeDir, ebookTextName(name)), { force: true });
  }
}
