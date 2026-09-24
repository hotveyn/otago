import { XMLParser } from 'fast-xml-parser';
import { unzipBook } from './epub.js';
import { decodeMarkup, type Ebook, EbookError, escapeHtml, htmlToMarkdown } from './html.js';

/** Ordered XML node: `{ tag: children, ':@': attributes }` or `{ '#text': text }`. */
type XmlNode = Record<string, unknown>;

const xml = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
});

const BLOCK_QUOTES = new Set(['epigraph', 'cite', 'annotation', 'poem']);
const INLINE_TAGS: Record<string, string> = {
  emphasis: 'em',
  strong: 'strong',
  code: 'code',
  td: 'td',
  th: 'th',
};
const DROPPED = new Set(['image', 'binary', 'empty-line']);

function tagOf(node: XmlNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

function childrenOf(node: XmlNode): XmlNode[] {
  const tag = tagOf(node);
  const children = tag ? node[tag] : undefined;
  return Array.isArray(children) ? (children as XmlNode[]) : [];
}

function attrsOf(node: XmlNode): Record<string, string> {
  return (node[':@'] as Record<string, string> | undefined) ?? {};
}

function find(nodes: XmlNode[], tag: string): XmlNode | undefined {
  return nodes.find((node) => tagOf(node) === tag);
}

function plainText(nodes: XmlNode[]): string {
  return nodes
    .map((node) => (tagOf(node) === '#text' ? String(node['#text']) : plainText(childrenOf(node))))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** FictionBook markup → HTML, so Turndown produces the Markdown. `depth` = heading level. */
function toHtml(nodes: XmlNode[], depth: number): string {
  return nodes.map((node) => nodeToHtml(node, depth)).join('');
}

function nodeToHtml(node: XmlNode, depth: number): string {
  const tag = tagOf(node);
  if (!tag || DROPPED.has(tag)) return '';
  if (tag === '#text') return escapeHtml(String(node['#text']));
  const children = childrenOf(node);
  switch (tag) {
    case 'section':
      return `<section>${toHtml(children, depth + 1)}</section>`;
    case 'title': {
      const level = Math.min(depth, 6);
      const lines = children.filter((child) => tagOf(child) === 'p');
      return `<h${level}>${lines.map((line) => toHtml(childrenOf(line), depth)).join(' ')}</h${level}>`;
    }
    case 'subtitle':
      return `<p><strong>${toHtml(children, depth)}</strong></p>`;
    case 'text-author':
      return `<p><em>${toHtml(children, depth)}</em></p>`;
    case 'stanza':
      return `<p>${children
        .filter((child) => tagOf(child) === 'v')
        .map((line) => toHtml(childrenOf(line), depth))
        .join('<br>')}</p>`;
    case 'p':
    case 'table':
    case 'tr':
      return `<${tag}>${toHtml(children, depth)}</${tag}>`;
    case 'a': {
      const href = attrsOf(node).href ?? '';
      const label = toHtml(children, depth);
      if (/^https?:/i.test(href)) return `<a href="${escapeHtml(href)}">${label}</a>`;
      return attrsOf(node).type === 'note' ? `[${label}]` : label;
    }
    default: {
      if (BLOCK_QUOTES.has(tag)) return `<blockquote>${toHtml(children, depth)}</blockquote>`;
      const inline = INLINE_TAGS[tag];
      const inner = toHtml(children, depth);
      return inline ? `<${inline}>${inner}</${inline}>` : inner;
    }
  }
}

export function parseFb2(data: Uint8Array): Ebook {
  // Embedded images (base64) are dropped before parsing: they can be most of the file.
  const text = decodeMarkup(data).replace(/<binary[\s\S]*?<\/binary>/gi, '');
  let root: XmlNode | undefined;
  try {
    root = find(xml.parse(text) as XmlNode[], 'FictionBook');
  } catch {
    throw new EbookError('invalid FictionBook XML');
  }
  if (!root) throw new EbookError('<FictionBook> root element is missing');
  const book = childrenOf(root);

  const titleInfo = childrenOf(
    find(childrenOf(find(book, 'description') ?? {}), 'title-info') ?? {},
  );
  const authors = titleInfo
    .filter((node) => tagOf(node) === 'author')
    .map((author) => {
      const fields = childrenOf(author);
      const name = ['first-name', 'middle-name', 'last-name']
        .map((field) => plainText(childrenOf(find(fields, field) ?? {})))
        .filter(Boolean)
        .join(' ');
      return name || plainText(childrenOf(find(fields, 'nickname') ?? {}));
    })
    .filter(Boolean);

  const parts: string[] = [];
  for (const body of book.filter((node) => tagOf(node) === 'body')) {
    const children = childrenOf(body);
    const name = attrsOf(body).name;
    // Footnote bodies usually have no title of their own.
    const heading = name && !find(children, 'title') ? `<h1>${escapeHtml(name)}</h1>` : '';
    const markdown = htmlToMarkdown(heading + toHtml(children, 1));
    if (markdown) parts.push(markdown);
  }

  return {
    title: plainText(childrenOf(find(titleInfo, 'book-title') ?? {})) || undefined,
    authors,
    parts,
  };
}

/** `.fb2.zip`: an archive with one `.fb2` file. */
export function parseFb2Zip(data: Uint8Array): Ebook {
  const files = unzipBook(data);
  const entry = Object.keys(files).find((name) => name.toLowerCase().endsWith('.fb2'));
  const content = entry ? files[entry] : undefined;
  if (!content) throw new EbookError('the archive has no .fb2 file');
  return parseFb2(content);
}
