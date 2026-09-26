import { i18n } from '../i18n';
export type CitationTarget =
  | { kind: 'source'; file: string; start?: number; end?: number }
  | { kind: 'url'; url: string; title?: string }
  | { kind: 'text'; text: string };

export interface Citation {
  /** Footnote label as written by the model, e.g. `1` or `book`. */
  key: string;
  /** Display number, in order of first reference. */
  number: number;
  target: CitationTarget;
}

const SOURCE_RE = /^(?:\.\/)?sources\/([^\s:]+?)(?::(\d+)(?:\s*[-–]\s*(\d+))?)?$/;
const MD_LINK_RE = /^\[([^\]]*)\]\((\S+?)\)$/;
const URL_RE = /https?:\/\/[^\s<>)\]]+/;
const DEFINITION_RE = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const REFERENCE_RE = /\[\^([^\]\s]+)\](?!:)/g;
const INLINE_SOURCE_RE =
  /(?<![\w/[(])((?:\.\/)?sources\/[\w.\- ]+?\.(?:md|txt|pdf):\d+(?:\s*[-–]\s*\d+)?)/g;

/** `sources/<file>:<start>-<end>` → parts, or null. */
export function parseSourceRef(ref: string): Extract<CitationTarget, { kind: 'source' }> | null {
  const match = SOURCE_RE.exec(ref.trim());
  if (!match) return null;
  const [, file, start, end] = match;
  if (!file) return null;
  const from = start ? Number(start) : undefined;
  return {
    kind: 'source',
    file: decodeURIComponent(file),
    start: from,
    end: end ? Number(end) : from,
  };
}

export function parseCitationTarget(raw: string): CitationTarget {
  const text = raw.trim().replace(/^<(.+)>$/, '$1');
  const source = parseSourceRef(text.replace(/^`(.+)`$/, '$1'));
  if (source) return source;
  const link = MD_LINK_RE.exec(text);
  if (link?.[2]) {
    const inner = parseSourceRef(link[2]);
    if (inner) return inner;
    if (/^https?:\/\//.test(link[2]))
      return { kind: 'url', url: link[2], title: link[1] || undefined };
  }
  const url = URL_RE.exec(text);
  if (url) {
    const title = text
      .replace(url[0], '')
      .replace(/[\s:–—-]+$|^[\s:–—-]+/g, '')
      .trim();
    return { kind: 'url', url: url[0], title: title || undefined };
  }
  return { kind: 'text', text };
}

/** Split markdown into prose and code (fenced blocks, inline code) so rewrites skip code. */
function mapProse(markdown: string, fn: (prose: string) => string): string {
  const parts = markdown.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?(?:^(?:```|~~~)[^\n]*$|(?![\s\S])))/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(/(`[^`\n]+`)/)
        .map((piece, j) => (j % 2 === 1 ? piece : fn(piece)))
        .join('');
    })
    .join('');
}

export const CITE_HREF_PREFIX = '#cite-';

/**
 * Pull footnote definitions out of an answer and rewrite references into `[n](#cite-key)` links,
 * so the renderer can show them as citation chips plus a source list.
 */
export function extractCitations(markdown: string): { body: string; citations: Citation[] } {
  const definitions = new Map<string, string>();
  const lines = markdown.split('\n');
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : DEFINITION_RE.exec(line);
    if (match?.[1]) definitions.set(match[1], match[2] ?? '');
    else kept.push(line);
  }

  const citations = new Map<string, Citation>();
  const citationFor = (key: string): Citation | undefined => {
    const existing = citations.get(key);
    if (existing) return existing;
    const raw = definitions.get(key);
    if (raw === undefined) return undefined;
    const citation = { key, number: citations.size + 1, target: parseCitationTarget(raw) };
    citations.set(key, citation);
    return citation;
  };

  const body = mapProse(kept.join('\n').replace(/\s+$/, ''), (prose) =>
    prose
      .replace(REFERENCE_RE, (whole, key: string) => {
        const citation = citationFor(key);
        return citation
          ? `[${citation.number}](${CITE_HREF_PREFIX}${encodeURIComponent(key)})`
          : whole;
      })
      .replace(INLINE_SOURCE_RE, (ref: string) => `[${ref}](${ref.replace(/ /g, '%20')})`),
  );
  for (const key of definitions.keys()) citationFor(key);
  return { body, citations: [...citations.values()] };
}

export function describeTarget(target: CitationTarget): string {
  switch (target.kind) {
    case 'source':
      return target.start === undefined
        ? target.file
        : target.end && target.end !== target.start
          ? `${target.file} · ${i18n.t('lines', { start: target.start, end: target.end })}`
          : `${target.file} · ${i18n.t('line', { start: target.start })}`;
    case 'url':
      return target.title ?? target.url;
    case 'text':
      return target.text;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** URL without scheme and host, for compact display. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname + parsed.search).replace(/\/$/, '');
    return path || parsed.hostname;
  } catch {
    return url;
  }
}
