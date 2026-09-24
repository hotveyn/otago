import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { attachmentUrl } from '../api/client';
import { useAttachmentBlob, useAttachmentText } from '../api/queries';
import { extensionOf, formatBytes, PREVIEW_LIMITS } from '../lib/attachments';
import { parseCsv } from '../lib/csv';
import { baseNameOf, delimiterFor } from './chat/AttachmentCard';
import { KindBadge } from './chat/AttachmentInline';
import { DataTable } from './chat/DataTable';
import { Markdown } from './chat/Markdown';
import type { AttachmentView } from './source-viewer-context';
import { ErrorNote } from './ui/ErrorNote';

/** Above this, text is shown without syntax highlighting. */
const HIGHLIGHT_LIMIT = 512 * 1024;

type Highlighter = typeof import('highlight.js/lib/common').default;
let highlighter: Promise<Highlighter> | null = null;
const loadHighlighter = () => {
  highlighter ??= import('highlight.js/lib/common').then((module) => module.default);
  return highlighter;
};

/** Line-numbered text; highlighted when highlight.js knows the extension. */
function CodeText({ text, extension }: { text: string; extension: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const body = text.replace(/\n$/, '');
  const lineCount = body.split('\n').length;

  useEffect(() => {
    setHtml(null);
    if (!extension || body.length > HIGHLIGHT_LIMIT) return;
    let stale = false;
    loadHighlighter().then((hljs) => {
      if (stale || !hljs.getLanguage(extension)) return;
      setHtml(hljs.highlight(body, { language: extension, ignoreIllegals: true }).value);
    });
    return () => {
      stale = true;
    };
  }, [body, extension]);

  return (
    <div className="code-lines">
      <pre className="code-lines-gutter" aria-hidden>
        {Array.from({ length: lineCount }, (_, index) => index + 1).join('\n')}
      </pre>
      {html === null ? (
        <pre className="code-lines-text">{body}</pre>
      ) : (
        <pre
          className="code-lines-text hljs"
          // highlight.js escapes the input; the output only adds its own spans.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped highlight.js output
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function TextBody({ view, rendered }: { view: AttachmentView; rendered: boolean }) {
  const { treeId, nodeId, attachment } = view;
  const text = useAttachmentText(treeId, nodeId, attachment.name, attachment.size, true);
  if (text.error)
    return (
      <div className="viewer-pad">
        <ErrorNote error={text.error} />
      </div>
    );
  if (text.data === undefined) return <p className="viewer-pad muted">Loading…</p>;
  if (rendered)
    return (
      <div className="viewer-pad">
        <Markdown text={text.data} plain />
      </div>
    );
  return <CodeText text={text.data} extension={extensionOf(attachment.name)} />;
}

function TableBody({ view, onAsText }: { view: AttachmentView; onAsText: () => void }) {
  const { treeId, nodeId, attachment } = view;
  const text = useAttachmentText(treeId, nodeId, attachment.name, attachment.size, true);
  const parsed = useMemo(
    () => (text.data === undefined ? null : parseCsv(text.data, delimiterFor(attachment.name))),
    [text.data, attachment.name],
  );
  if (text.error)
    return (
      <div className="viewer-pad">
        <ErrorNote error={text.error} />
      </div>
    );
  if (text.data === undefined) return <p className="viewer-pad muted">Loading…</p>;
  if (!parsed)
    return (
      <p className="viewer-pad muted">
        Could not parse;{' '}
        <button type="button" className="link-btn" onClick={onAsText}>
          Preview as text
        </button>
      </p>
    );
  return (
    <div className="viewer-pad">
      <DataTable
        header={parsed.header}
        rows={parsed.rows}
        baseName={baseNameOf(attachment.name)}
        fullFileUrl={attachmentUrl(treeId, nodeId, attachment.name, true)}
      />
    </div>
  );
}

/** PDF through a blob: URL, since the attachment route's CSP sandbox blocks the PDF viewer. */
function PdfBody({ view }: { view: AttachmentView }) {
  const { treeId, nodeId, attachment } = view;
  const blob = useAttachmentBlob(treeId, nodeId, attachment.name, attachment.size);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    const typed =
      blob.data.type === 'application/pdf'
        ? blob.data
        : new Blob([blob.data], { type: 'application/pdf' });
    const objectUrl = URL.createObjectURL(typed);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob.data]);
  if (blob.error)
    return (
      <div className="viewer-pad">
        <ErrorNote error={blob.error} />
      </div>
    );
  if (!url) return <p className="viewer-pad muted">Loading…</p>;
  return <iframe className="viewer-pdf" title={attachment.name} src={url} />;
}

function Unavailable({ download, reason }: { download: string; reason: string }) {
  return (
    <div className="viewer-pad">
      <p className="muted">{reason}</p>
      <a className="btn btn-sm" href={download} download>
        Download
      </a>
    </div>
  );
}

interface AttachmentViewerProps {
  view: AttachmentView;
  onClose: () => void;
}

/** Side panel for one attachment: text/code, table, image/SVG, PDF, or metadata + Download. */
export function AttachmentViewer({ view, onClose }: AttachmentViewerProps) {
  const { treeId, nodeId, attachment } = view;
  const [asText, setAsText] = useState(view.asText ?? false);
  const [rendered, setRendered] = useState(false);
  const inline = attachmentUrl(treeId, nodeId, attachment.name);
  const download = attachmentUrl(treeId, nodeId, attachment.name, true);
  const isMarkdown = extensionOf(attachment.name) === 'md';
  const kind = asText ? 'text' : attachment.kind;

  useEffect(() => {
    setAsText(view.asText ?? false);
    setRendered(false);
  }, [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tooLarge = 'Too large to preview.';
  let body: ReactNode;
  switch (kind) {
    case 'text':
      body =
        attachment.size <= PREVIEW_LIMITS.textBytes ? (
          <TextBody view={view} rendered={isMarkdown && rendered} />
        ) : (
          <Unavailable download={download} reason={tooLarge} />
        );
      break;
    case 'table':
      body =
        attachment.size <= PREVIEW_LIMITS.tableBytes ? (
          <TableBody view={view} onAsText={() => setAsText(true)} />
        ) : (
          <Unavailable download={download} reason={tooLarge} />
        );
      break;
    case 'image':
    case 'svg':
      body =
        attachment.size <= PREVIEW_LIMITS.imageBytes ? (
          <div className={`viewer-pad viewer-image viewer-image-${kind}`}>
            <img src={inline} alt={attachment.name} />
          </div>
        ) : (
          <Unavailable download={download} reason={tooLarge} />
        );
      break;
    case 'pdf':
      body =
        attachment.size <= PREVIEW_LIMITS.pdfBytes ? (
          <PdfBody view={view} />
        ) : (
          <Unavailable download={download} reason={tooLarge} />
        );
      break;
    default:
      body = <Unavailable download={download} reason="No preview for this file type." />;
  }

  return (
    <div className="viewer" role="dialog" aria-label={`Attachment ${attachment.name}`}>
      <header className="viewer-header">
        <KindBadge name={attachment.name} />
        <span className="viewer-title truncate">{attachment.name}</span>
        <span className="cite-lines">{formatBytes(attachment.size)}</span>
        <span className="spacer" />
        {isMarkdown && kind === 'text' && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setRendered(!rendered)}
          >
            {rendered ? 'Lines' : 'Rendered'}
          </button>
        )}
        <a className="btn btn-ghost btn-sm" href={inline} target="_blank" rel="noreferrer">
          Open ↗
        </a>
        <a className="btn btn-ghost btn-sm" href={download} download={attachment.name}>
          Download
        </a>
        <button type="button" className="icon-btn" aria-label="Close attachment" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="viewer-body">{body}</div>
    </div>
  );
}
