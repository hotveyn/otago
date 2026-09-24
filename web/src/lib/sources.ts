/** E-books are stored with their extracted text next to them: `book.epub` → `book.epub.md`. */
export const EBOOK_EXTENSIONS = ['.fb2.zip', '.epub', '.fb2', '.mobi', '.azw', '.azw3'];

export const SOURCE_ACCEPT = ['.md', '.txt', '.pdf', ...EBOOK_EXTENSIONS].join(',');

export function ebookExtensionOf(name: string): string | undefined {
  const lower = name.toLowerCase();
  return EBOOK_EXTENSIONS.find((ext) => lower.endsWith(ext));
}

/** `book.epub.md` → `book.epub`; undefined for other files. */
export function bookOfText(name: string): string | undefined {
  if (!name.toLowerCase().endsWith('.md')) return undefined;
  const book = name.slice(0, -3);
  return ebookExtensionOf(book) ? book : undefined;
}

/** File to show for a source: an e-book opens as its extracted text. */
export function viewableFile(name: string): string {
  return ebookExtensionOf(name) ? `${name}.md` : name;
}

/** Short format label: `fb2.zip` → `fb2`, `book.epub.md` → `epub`. */
export function formatLabel(name: string): string {
  const book = bookOfText(name) ?? name;
  const ebook = ebookExtensionOf(book);
  if (ebook) return ebook.split('.')[1] ?? '';
  return book.slice(book.lastIndexOf('.') + 1).toLowerCase();
}
