import TurndownService from 'turndown';

/** Parsed book, ready to render as one Markdown file. */
export interface Ebook {
  title?: string;
  authors: string[];
  /** Markdown of each reading-order part (chapter, body, flow). */
  parts: string[];
}

/** Invalid or unsupported book file. The message is shown to the user. */
export class EbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EbookError';
  }
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
});
const DROPPED_TAGS = new Set(['head', 'title', 'script', 'style', 'svg', 'img', 'image']);
// A rule, not `remove()`: removal is checked after the built-in rules (which include images).
turndown.addRule('dropped', {
  filter: (node) => DROPPED_TAGS.has(node.nodeName.toLowerCase()),
  replacement: () => '',
});
// Links inside a book (chapters, footnotes) do not resolve in the extracted text: keep the label.
turndown.addRule('localLinks', {
  filter: (node) => node.nodeName === 'A' && !/^https?:/i.test(node.getAttribute('href') ?? ''),
  replacement: (content) => content,
});

/** HTML fragment → Markdown with at most one blank line between blocks. */
export function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(html)
    .replace(/[ \t]+$/gm, (spaces) => (spaces === '  ' ? spaces : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Decode an XML/HTML document, honoring its `encoding="…"` / `charset=…` declaration. */
export function decodeMarkup(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const declared =
    /<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ??
    /<meta[^>]*charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  return decodeText(bytes, declared ?? 'utf-8');
}

export function decodeText(bytes: Uint8Array, encoding: string): string {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Inner HTML of `<body>`, or the whole document when there is none. */
export function bodyOf(html: string): string {
  const open = /<body[^>]*>/i.exec(html);
  if (!open) return html;
  const start = open.index + open[0].length;
  const end = html.toLowerCase().lastIndexOf('</body>');
  return html.slice(start, end > start ? end : undefined);
}
