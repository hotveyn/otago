import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';
import { bodyOf, decodeMarkup, type Ebook, EbookError, htmlToMarkdown } from './html.js';

const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html']);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ['rootfile', 'item', 'itemref', 'title', 'creator'].includes(name),
});

interface ManifestItem {
  id?: string;
  href?: string;
  'media-type'?: string;
}

/** Unzip or throw `EbookError`. */
export function unzipBook(data: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(data);
  } catch {
    throw new EbookError('not a valid ZIP archive');
  }
}

function textOf(value: unknown): string | undefined {
  const text =
    typeof value === 'string' ? value : (value as { '#text'?: unknown } | undefined)?.['#text'];
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

function decodePath(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/** Reading order of an EPUB 2/3: container.xml → OPF spine → XHTML documents. */
export function parseEpub(data: Uint8Array): Ebook {
  const files = unzipBook(data);
  const byLowerName = new Map(Object.keys(files).map((name) => [name.toLowerCase(), name]));
  const file = (name: string) => files[name] ?? files[byLowerName.get(name.toLowerCase()) ?? ''];

  const container = file('META-INF/container.xml');
  if (!container) throw new EbookError('META-INF/container.xml is missing');
  const rootfile = xml.parse(strFromU8(container))?.container?.rootfiles?.rootfile?.[0];
  const opfPath = typeof rootfile?.['full-path'] === 'string' ? rootfile['full-path'] : undefined;
  const opf = opfPath ? file(opfPath) : undefined;
  if (!opfPath || !opf) throw new EbookError('package document (OPF) is missing');

  const pkg = xml.parse(decodeMarkup(opf))?.package;
  const opfDir = path.posix.dirname(opfPath);
  const items = new Map<string, ManifestItem>();
  for (const item of (pkg?.manifest?.item ?? []) as ManifestItem[]) {
    if (item.id) items.set(item.id, item);
  }

  const encrypted = encryptedPaths(file('META-INF/encryption.xml'));
  const parts: string[] = [];
  for (const ref of (pkg?.spine?.itemref ?? []) as Array<{ idref?: string }>) {
    const item = ref.idref ? items.get(ref.idref) : undefined;
    if (!item?.href || !HTML_TYPES.has(item['media-type'] ?? '')) continue;
    const entry = path.posix.join(opfDir, decodePath(item.href.split('#')[0] ?? ''));
    if (encrypted.has(entry)) throw new EbookError('the book is DRM-protected');
    const content = file(entry);
    if (!content) continue;
    const markdown = htmlToMarkdown(bodyOf(decodeMarkup(content)));
    if (markdown) parts.push(markdown);
  }

  const metadata = pkg?.metadata;
  return {
    title: textOf(metadata?.title?.[0]),
    authors: ((metadata?.creator ?? []) as unknown[])
      .map(textOf)
      .filter((name): name is string => name !== undefined),
    parts,
  };
}

/** Archive paths listed in `META-INF/encryption.xml` (DRM or font obfuscation). */
function encryptedPaths(encryption: Uint8Array | undefined): Set<string> {
  if (!encryption) return new Set();
  const uris = [...strFromU8(encryption).matchAll(/CipherReference[^>]*URI\s*=\s*["']([^"']+)/g)];
  return new Set(uris.map((match) => path.posix.normalize(decodePath(match[1] ?? ''))));
}
