import type { Element, ElementContent } from 'hast';
import { createContext, memo, type ReactNode, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { parseAttachmentHref } from '../../lib/attachments';
import {
  CITE_HREF_PREFIX,
  type Citation,
  type CitationTarget,
  describeTarget,
  extractCitations,
  hostOf,
  parseSourceRef,
  pathOf,
} from '../../lib/citations';
import { isFenceClosed } from '../../lib/fences';
import { type SourceView, useOpenSource } from '../source-viewer-context';
import { AttachmentImage, AttachmentLink } from './AttachmentInline';
import { CodeFrame } from './CodeFrame';
import { CsvBlock } from './CsvBlock';
import { MermaidBlock } from './MermaidBlock';
import { SmartTable } from './SmartTable';

function textOf(node: ElementContent | Element): string {
  if (node.type === 'text') return node.value;
  if ('children' in node)
    return node.children.map((child) => textOf(child as ElementContent)).join('');
  return '';
}

function languageOf(node: Element | undefined): string | null {
  const code = node?.children.find((child): child is Element => child.type === 'element');
  const classes = code?.properties.className;
  if (!Array.isArray(classes)) return null;
  const language = classes.map(String).find((name) => name.startsWith('language-'));
  return language ? language.slice('language-'.length) : null;
}

function CodeBlock({ node, children }: { node?: Element; children?: ReactNode }) {
  return (
    <CodeFrame
      label={languageOf(node) ?? 'text'}
      copyText={() => (node ? textOf(node).replace(/\n$/, '') : '')}
    >
      <pre>{children}</pre>
    </CodeFrame>
  );
}

function openTarget(target: CitationTarget, openSource: (view: SourceView) => void) {
  if (target.kind === 'source')
    openSource({ file: target.file, start: target.start, end: target.end });
  else if (target.kind === 'url') window.open(target.url, '_blank', 'noopener,noreferrer');
}

function CitationChip({ citation }: { citation: Citation }) {
  const openSource = useOpenSource();
  const clickable = citation.target.kind !== 'text';
  return (
    <button
      type="button"
      className={`cite-chip cite-${citation.target.kind}`}
      title={describeTarget(citation.target)}
      onClick={() => openTarget(citation.target, openSource)}
      disabled={!clickable}
    >
      {citation.number}
    </button>
  );
}

function SourceLink({ view, children }: { view: SourceView; children: ReactNode }) {
  const openSource = useOpenSource();
  return (
    <button type="button" className="source-link" onClick={() => openSource(view)}>
      {children}
    </button>
  );
}

function CitationList({ citations }: { citations: Citation[] }) {
  const { t } = useTranslation(['common', 'chat']);
  const openSource = useOpenSource();
  return (
    <aside className="citations">
      <h4>{t('chat:citations.heading')}</h4>
      <ol>
        {citations.map((citation) => {
          const { target } = citation;
          return (
            <li key={citation.key}>
              <span className="cite-num">{citation.number}</span>
              {target.kind === 'source' && (
                <button
                  type="button"
                  className="cite-row"
                  onClick={() => openTarget(target, openSource)}
                >
                  <span className="file-badge">{target.file.split('.').pop()}</span>
                  <span className="cite-file">{target.file}</span>
                  {target.start !== undefined && (
                    <span className="cite-lines">
                      {target.end && target.end !== target.start
                        ? t('lines', { start: target.start, end: target.end })
                        : t('line', { start: target.start })}
                    </span>
                  )}
                </button>
              )}
              {target.kind === 'url' && (
                <a className="cite-row" href={target.url} target="_blank" rel="noopener noreferrer">
                  <span className="cite-host">{hostOf(target.url)}</span>
                  <span className="cite-title truncate">{target.title ?? pathOf(target.url)}</span>
                  <span className="external-mark" aria-hidden>
                    ↗
                  </span>
                </a>
              )}
              {target.kind === 'text' && <span className="cite-row cite-text">{target.text}</span>}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

interface RenderData {
  /** The text ReactMarkdown parses; node positions are offsets into it. */
  body: string;
  streaming: boolean;
  citations: Map<string, Citation>;
}

const RenderContext = createContext<RenderData>({
  body: '',
  streaming: false,
  citations: new Map(),
});

// Overrides are module-level (stable identities) and read per-render data from context, so
// stateful blocks (diagrams, sorted tables) are not remounted on every streamed chunk.

function Pre({ node, children }: { node?: Element; children?: ReactNode }) {
  const { body, streaming } = useContext(RenderContext);
  const language = languageOf(node);
  if (node && (language === 'mermaid' || language === 'csv' || language === 'tsv')) {
    const source = textOf(node).replace(/\n$/, '');
    // A finished answer always attempts a render; errors fall back to the source.
    const closed = !streaming || isFenceClosed(body, node.position);
    if (language === 'mermaid') return <MermaidBlock source={source} closed={closed} />;
    return <CsvBlock source={source} delimiter={language === 'tsv' ? '\t' : ','} closed={closed} />;
  }
  return <CodeBlock node={node}>{children}</CodeBlock>;
}

function Anchor({ href = '', children }: { href?: string; children?: ReactNode }) {
  const { citations } = useContext(RenderContext);
  if (href.startsWith(CITE_HREF_PREFIX)) {
    const citation = citations.get(decodeURIComponent(href.slice(CITE_HREF_PREFIX.length)));
    if (citation) return <CitationChip citation={citation} />;
  }
  const attachment = parseAttachmentHref(href);
  if (attachment) return <AttachmentLink name={attachment}>{children}</AttachmentLink>;
  const source = parseSourceRef(safeDecode(href));
  if (source) {
    return (
      <SourceLink view={{ file: source.file, start: source.start, end: source.end }}>
        {children}
      </SourceLink>
    );
  }
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="external">
        {children}
      </a>
    );
  }
  return <a href={href}>{children}</a>;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function Img({ src, alt, title }: { src?: unknown; alt?: string; title?: string }) {
  const url = typeof src === 'string' ? src : undefined;
  const attachment = parseAttachmentHref(url);
  if (attachment) return <AttachmentImage name={attachment} alt={alt} />;
  return <img src={url} alt={alt} title={title} />;
}

const components: Components = {
  pre: ({ node, children }) => <Pre node={node}>{children}</Pre>,
  table: ({ node, children }) => <SmartTable node={node}>{children}</SmartTable>,
  a: ({ href, children }) => <Anchor href={href}>{children}</Anchor>,
  img: ({ src, alt, title }) => <Img src={src} alt={alt} title={title} />,
};

interface MarkdownProps {
  text: string;
  /**
   * Mode for user questions: no citations/source list; line breaks kept via `.msg-user .md p` CSS.
   */
  plain?: boolean;
  /** The text is still streaming: unclosed diagram/table fences are not rendered yet. */
  streaming?: boolean;
}

/** Answer renderer: GFM, highlighted code, citation chips and a source list. */
export const Markdown = memo(function Markdown({ text, plain, streaming = false }: MarkdownProps) {
  const { body, citations } = useMemo(
    () => (plain ? { body: text, citations: [] } : extractCitations(text)),
    [text, plain],
  );

  const context = useMemo<RenderData>(
    () => ({
      body,
      streaming,
      citations: new Map(citations.map((citation) => [citation.key, citation])),
    }),
    [body, streaming, citations],
  );

  return (
    <div className="md">
      <RenderContext.Provider value={context}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, { detect: false }]]}
          components={components}
        >
          {body}
        </ReactMarkdown>
      </RenderContext.Provider>
      {citations.length > 0 && <CitationList citations={citations} />}
    </div>
  );
});
