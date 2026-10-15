import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sourceUrl } from '../api/client';
import { useSourceText } from '../api/queries';
import { describeRange } from '../lib/citations';
import { bookOfText, formatLabel, viewableFile } from '../lib/sources';
import { Markdown } from './chat/Markdown';
import { LineView } from './LineView';
import type { SourceView } from './source-viewer-context';
import { ErrorNote } from './ui/ErrorNote';

interface SourceViewerProps {
  treeId: string;
  view: SourceView;
  onClose: () => void;
}

export function SourceViewer({ treeId, view, onClose }: SourceViewerProps) {
  const { t } = useTranslation(['viewer', 'common']);
  // A citation to the book file itself still opens its extracted text.
  const file = viewableFile(view.file);
  const book = bookOfText(file);
  const isPdf = file.toLowerCase().endsWith('.pdf');
  const isMarkdown = file.toLowerCase().endsWith('.md');
  const text = useSourceText(treeId, file, !isPdf);
  const [rendered, setRendered] = useState(false);
  const start = view.start;
  const end = view.end ?? view.start;
  const range = describeRange(file, start, end);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A new citation into the same file switches back to line view.
  useEffect(() => {
    if (start !== undefined) setRendered(false);
  }, [start]);

  return (
    <div className="viewer" role="dialog" aria-label={t('sourceLabel', { name: book ?? file })}>
      <header className="viewer-header">
        <span className="file-badge">{formatLabel(file)}</span>
        <span className="viewer-title truncate">{book ?? file}</span>
        {range && <span className="cite-lines">{range}</span>}
        <span className="spacer" />
        {isMarkdown && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setRendered(!rendered)}
          >
            {rendered ? t('lines') : t('rendered')}
          </button>
        )}
        {book && (
          <a className="btn btn-ghost btn-sm" href={sourceUrl(treeId, book)} download={book}>
            {t('book')}
          </a>
        )}
        <a
          className="btn btn-ghost btn-sm"
          href={sourceUrl(treeId, file)}
          target="_blank"
          rel="noreferrer"
        >
          {t('raw')}
        </a>
        <button type="button" className="icon-btn" aria-label={t('closeSource')} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="viewer-body">
        {isPdf ? (
          <iframe className="viewer-pdf" title={file} src={sourceUrl(treeId, file)} />
        ) : text.error ? (
          <div className="viewer-pad">
            <ErrorNote error={text.error} />
          </div>
        ) : text.data === undefined ? (
          <p className="viewer-pad muted">{t('common:loading')}</p>
        ) : rendered ? (
          <div className="viewer-pad">
            <Markdown text={text.data} plain />
          </div>
        ) : (
          <LineView text={text.data} start={start} end={end} />
        )}
      </div>
    </div>
  );
}
