import { InvalidInputError } from '../../errors.js';
import { parseEpub } from './epub.js';
import { parseFb2, parseFb2Zip } from './fb2.js';
import { type Ebook, EbookError } from './html.js';
import { parseMobi } from './mobi.js';

interface EbookFormat {
  contentType: string;
  parse: (data: Uint8Array) => Ebook;
}

/** Longer extensions first, so `.fb2.zip` wins over a plain match. */
const FORMATS: Record<string, EbookFormat> = {
  '.fb2.zip': { contentType: 'application/zip', parse: parseFb2Zip },
  '.epub': { contentType: 'application/epub+zip', parse: parseEpub },
  '.fb2': { contentType: 'application/x-fictionbook+xml', parse: parseFb2 },
  '.mobi': { contentType: 'application/x-mobipocket-ebook', parse: parseMobi },
  '.azw': { contentType: 'application/vnd.amazon.ebook', parse: parseMobi },
  '.azw3': { contentType: 'application/vnd.amazon.ebook', parse: parseMobi },
};

export const EBOOK_EXTENSIONS = Object.keys(FORMATS);

/** Suffix of the Markdown text extracted from a book: `book.epub` → `book.epub.md`. */
export const EBOOK_TEXT_SUFFIX = '.md';

/** Matching e-book extension (lowercase, with the dot), if any. */
export function ebookExtensionOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  return EBOOK_EXTENSIONS.find((ext) => lower.endsWith(ext));
}

export function ebookContentType(name: string): string | undefined {
  const ext = ebookExtensionOf(name);
  return ext ? FORMATS[ext]?.contentType : undefined;
}

export function ebookTextName(name: string): string {
  return `${name}${EBOOK_TEXT_SUFFIX}`;
}

/**
 * Extract the book as one Markdown document. Throws `InvalidInputError` for bad files.
 * `label` is the tree-relative path named in the header comment.
 */
export function extractEbookText(
  name: string,
  data: Uint8Array,
  label = `sources/${name}`,
): string {
  const format = FORMATS[ebookExtensionOf(name) ?? ''];
  if (!format) throw new InvalidInputError(`Not an e-book: ${name}`);
  let book: Ebook;
  try {
    book = format.parse(data);
  } catch (error) {
    if (error instanceof EbookError)
      throw new InvalidInputError(`Cannot read ${name}: ${error.message}`);
    throw error;
  }
  if (book.parts.length === 0) {
    throw new InvalidInputError(`Cannot read ${name}: no text found (scanned or image-only book?)`);
  }
  const header = [`<!-- Text extracted by Otago from ${label} -->`];
  if (book.title) header.push(`# ${book.title}`);
  if (book.authors.length > 0) header.push(`*${book.authors.join(', ')}*`);
  return `${[...header, ...book.parts].join('\n\n')}\n`;
}
