import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sourceUrl } from '../api/client';
import { useSourceText } from '../api/queries';
import { bookOfText, formatLabel, viewableFile } from '../lib/sources';
import { Markdown } from './chat/Markdown';
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
  const highlight = useRef<HTMLDivElement>(null);
  const start = view.start;
  const end = view.end ?? view.start;

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll when the cited range changes
  useEffect(() => {
    if (text.data !== undefined && !rendered)
      highlight.current?.scrollIntoView({ block: 'center' });
  }, [text.data, rendered, start, end]);

  const lines = text.data?.replace(/\n$/, '').split('\n') ?? [];

  return (
    <div className="viewer" role="dialog" aria-label={t('sourceLabel', { name: book ?? file })}>
      <header className="viewer-header">
        <span className="file-badge">{formatLabel(file)}</span>
        <span className="viewer-title truncate">{book ?? file}</span>
        {start !== undefined && (
          <span className="cite-lines">
            {end !== start ? t('common:lines', { start, end }) : t('common:line', { start })}
          </span>
        )}
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
          <div className="lines">
            {lines.map((line, index) => {
              const number = index + 1;
              const inRange =
                start !== undefined && end !== undefined && number >= start && number <= end;
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                  key={index}
                  ref={number === start ? highlight : undefined}
                  className={inRange ? 'line line-hit' : 'line'}
                >
                  <span className="line-no">{number}</span>
                  <span className="line-text">{line || ' '}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
