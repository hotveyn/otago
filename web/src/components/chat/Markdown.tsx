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
  describeRange,
  describeTarget,
  extractCitations,
  type FileTarget,
  hostOf,
  labelOf,
  parseWholeRef,
  pathOf,
} from '../../lib/citations';
import { isFenceClosed } from '../../lib/fences';
import { type CitationScope, type OpenAction, openActionFor } from '../../lib/open-citation';
import { formatLabel } from '../../lib/sources';
import { useOpenAttachment, useOpenSource } from '../source-viewer-context';
import { IdPath } from '../ui/IdPath';
import { AttachmentImage, AttachmentLink } from './AttachmentInline';
import { useAttachmentScope } from './attachment-scope';
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

/** Tree + committed node the citations of this answer resolve against (null = no answer). */
function useCitationScope(): CitationScope | null {
  const scope = useAttachmentScope();
  return scope ? { treeId: scope.treeId, nodeId: scope.nodeId } : null;
}

function useCitationAction(target: CitationTarget): OpenAction {
  return openActionFor(target, useCitationScope());
}

/** A `files/` ref of the answer's own node that cannot be resolved until the answer is saved. */
const pendingFile = (target: CitationTarget, action: OpenAction) =>
  target.kind === 'file' && action.kind === 'none';

interface TargetLinkProps {
  action: OpenAction;
  className: string;
  title?: string;
  /** Element for an action-less target: a disabled button (chips) or a span (rows, inline). */
  inert: 'button' | 'span';
  children: ReactNode;
}

/**
 * The one element that performs an `OpenAction`: a real anchor for new tabs (the href is
 * precomputed, so the browser opens it synchronously from the click), a button for the in-app
 * viewers, an inert element otherwise.
 */
function TargetLink({ action, className, title, inert, children }: TargetLinkProps) {
  const scope = useCitationScope();
  const openSource = useOpenSource();
  const openAttachment = useOpenAttachment();
  if (action.kind === 'new-tab')
    return (
      <a
        className={className}
        href={action.url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
      >
        {children}
      </a>
    );
  if (action.kind === 'viewer') {
    const open = () => {
      if (action.where === 'source')
        openSource({ file: action.name, start: action.start, end: action.end });
      else if (scope)
        openAttachment({
          treeId: scope.treeId,
          nodeId: action.node,
          folder: 'files',
          // Size unknown (0 passes the preview limit); the text is fetched once at most.
          attachment: {
            name: action.name,
            kind: 'text',
            contentType: action.name.toLowerCase().endsWith('.md')
              ? 'text/markdown; charset=utf-8'
              : 'text/plain; charset=utf-8',
            size: 0,
          },
          start: action.start,
          end: action.end,
        });
    };
    return (
      <button type="button" className={className} title={title} onClick={open}>
        {children}
      </button>
    );
  }
  if (inert === 'button')
    return (
      <button type="button" className={className} title={title} disabled>
        {children}
      </button>
    );
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

function CitationChip({ citation }: { citation: Citation }) {
  const { t } = useTranslation('chat');
  const { target } = citation;
  const action = useCitationAction(target);
  const title = pendingFile(target, action) ? t('citations.afterSave') : describeTarget(target);
  return (
    <TargetLink
      action={action}
      className={`cite-chip cite-${target.kind}`}
      title={title}
      inert="button"
    >
      {citation.number}
    </TargetLink>
  );
}

function FileRow({ target }: { target: FileTarget }) {
  const { t } = useTranslation('chat');
  const action = useCitationAction(target);
  const name = labelOf(target);
  const range = describeRange(name, target.start, target.end);
  const inert = action.kind === 'none';
  return (
    <TargetLink
      action={action}
      className={inert ? 'cite-row cite-text' : 'cite-row'}
      title={pendingFile(target, action) ? t('citations.afterSave') : undefined}
      inert="span"
    >
      <span className="file-badge">{formatLabel(name)}</span>
      <span className="cite-file" dir="auto">
        {target.kind === 'file' ? (
          <>
            {target.node !== undefined && (
              <>
                <IdPath id={target.node} />/
              </>
            )}
            files/{target.name}
          </>
        ) : (
          target.file
        )}
      </span>
      {range && <span className="cite-lines">{range}</span>}
      {target.comment !== undefined && (
        <span className="cite-comment muted truncate" dir="auto" title={target.comment}>
          {target.comment}
        </span>
      )}
      {action.kind === 'new-tab' && (
        <span className="external-mark" aria-hidden>
          ↗
        </span>
      )}
    </TargetLink>
  );
}

function CitationRow({ target }: { target: CitationTarget }) {
  switch (target.kind) {
    case 'source':
    case 'file':
      return <FileRow target={target} />;
    case 'url':
      return (
        <a className="cite-row" href={target.url} target="_blank" rel="noopener noreferrer">
          <span className="cite-host">{hostOf(target.url)}</span>
          <span className="cite-title truncate">{target.title ?? pathOf(target.url)}</span>
          {target.comment !== undefined && (
            <span className="cite-comment muted truncate" dir="auto" title={target.comment}>
              {target.comment}
            </span>
          )}
          <span className="external-mark" aria-hidden>
            ↗
          </span>
        </a>
      );
    case 'text':
      return <span className="cite-row cite-text">{target.text}</span>;
  }
}

function CitationList({ citations }: { citations: Citation[] }) {
  const { t } = useTranslation('chat');
  return (
    <aside className="citations">
      <h4>{t('citations.heading')}</h4>
      <ol>
        {citations.map((citation) => (
          <li key={citation.key}>
            <span className="cite-num">{citation.number}</span>
            <CitationRow target={citation.target} />
          </li>
        ))}
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

/** An inline `sources/…` or `files/…` link in the body. */
function InlineRef({ target, children }: { target: FileTarget; children?: ReactNode }) {
  const { t } = useTranslation('chat');
  const action = useCitationAction(target);
  const className =
    action.kind === 'new-tab'
      ? 'source-link external'
      : action.kind === 'none'
        ? 'source-link cite-text'
        : 'source-link';
  return (
    <TargetLink
      action={action}
      className={className}
      title={pendingFile(target, action) ? t('citations.afterSave') : undefined}
      inert="span"
    >
      {children}
    </TargetLink>
  );
}

function Anchor({ href = '', children }: { href?: string; children?: ReactNode }) {
  const { citations } = useContext(RenderContext);
  if (href.startsWith(CITE_HREF_PREFIX)) {
    const citation = citations.get(decodeURIComponent(href.slice(CITE_HREF_PREFIX.length)));
    if (citation) return <CitationChip citation={citation} />;
  }
  const attachment = parseAttachmentHref(href);
  if (attachment) return <AttachmentLink name={attachment}>{children}</AttachmentLink>;
  const ref = parseWholeRef(safeDecode(href));
  if (ref) return <InlineRef target={ref}>{children}</InlineRef>;
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
