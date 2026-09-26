import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nodeFileUrl } from '../api/client';
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
  const { t } = useTranslation();
  const { treeId, nodeId, attachment, folder } = view;
  const text = useAttachmentText(treeId, nodeId, attachment.name, attachment.size, true, folder);
  if (text.error)
    return (
      <div className="viewer-pad">
        <ErrorNote error={text.error} />
      </div>
    );
  if (text.data === undefined) return <p className="viewer-pad muted">{t('loading')}</p>;
  if (rendered)
    return (
      <div className="viewer-pad">
        <Markdown text={text.data} plain />
      </div>
    );
  return <CodeText text={text.data} extension={extensionOf(attachment.name)} />;
}

function TableBody({ view, onAsText }: { view: AttachmentView; onAsText: () => void }) {
  const { t } = useTranslation(['viewer', 'common']);
  const { treeId, nodeId, attachment, folder = 'attachments' } = view;
  const text = useAttachmentText(treeId, nodeId, attachment.name, attachment.size, true, folder);
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
  if (text.data === undefined) return <p className="viewer-pad muted">{t('common:loading')}</p>;
  if (!parsed)
    return (
      <p className="viewer-pad muted">
        {t('couldNotParse')}{' '}
        <button type="button" className="link-btn" onClick={onAsText}>
          {t('previewAsText')}
        </button>
      </p>
    );
  return (
    <div className="viewer-pad">
      <DataTable
        header={parsed.header}
        rows={parsed.rows}
        baseName={baseNameOf(attachment.name)}
        fullFileUrl={nodeFileUrl(folder, treeId, nodeId, attachment.name, true)}
      />
    </div>
  );
}

/** PDF through a blob: URL, since the attachment route's CSP sandbox blocks the PDF viewer. */
function PdfBody({ view }: { view: AttachmentView }) {
  const { treeId, nodeId, attachment, folder } = view;
  const { t } = useTranslation();
  const blob = useAttachmentBlob(treeId, nodeId, attachment.name, attachment.size, folder);
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
  if (!url) return <p className="viewer-pad muted">{t('loading')}</p>;
  return <iframe className="viewer-pdf" title={attachment.name} src={url} />;
}

function Unavailable({ download, reason }: { download: string; reason: string }) {
  const { t } = useTranslation();
  return (
    <div className="viewer-pad">
      <p className="muted">{reason}</p>
      <a className="btn btn-sm" href={download} download>
        {t('download')}
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
  const { t } = useTranslation(['viewer', 'common']);
  const { treeId, nodeId, attachment } = view;
  const folder = view.folder ?? 'attachments';
  const [asText, setAsText] = useState(view.asText ?? false);
  const [rendered, setRendered] = useState(false);
  const inline = nodeFileUrl(folder, treeId, nodeId, attachment.name);
  const download = nodeFileUrl(folder, treeId, nodeId, attachment.name, true);
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

  const tooLarge = t('tooLarge');
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
      body = <Unavailable download={download} reason={t('noPreview')} />;
  }

  return (
    <div
      className="viewer"
      role="dialog"
      aria-label={t(folder === 'files' ? 'fileLabel' : 'attachmentLabel', {
        name: attachment.name,
      })}
    >
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
            {rendered ? t('lines') : t('rendered')}
          </button>
        )}
        <a className="btn btn-ghost btn-sm" href={inline} target="_blank" rel="noreferrer">
          {t('open')}
        </a>
        <a className="btn btn-ghost btn-sm" href={download} download={attachment.name}>
          {t('common:download')}
        </a>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('closeAttachment')}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="viewer-body">{body}</div>
    </div>
  );
}
