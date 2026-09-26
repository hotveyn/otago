import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { nodeFileUrl } from '../../api/client';
import { useAttachmentText } from '../../api/queries';
import type { AttachmentInfo, FileFolder } from '../../api/types';
import {
  canPreview,
  extensionOf,
  formatBytes,
  type StreamingAttachment,
} from '../../lib/attachments';
import { parseCsv } from '../../lib/csv';
import { useOpenAttachment } from '../source-viewer-context';
import { errorMessage } from '../ui/ErrorNote';
import { BrokenAttachment, KindBadge } from './AttachmentInline';
import { DataTable } from './DataTable';

const COLLAPSED_ROWS = 10;

export const baseNameOf = (name: string) => name.replace(/\.[^.]+$/, '') || name;

export const delimiterFor = (name: string) => (extensionOf(name) === 'tsv' ? '\t' : undefined);

interface CardProps {
  treeId: string;
  nodeId: string;
  /** A user file (`files`) may carry `text`: its e-book companion. */
  info: AttachmentInfo & { text?: string };
  /** Node folder the file lives in; defaults to agent `attachments`. */
  folder?: FileFolder;
}

function TablePreview({
  treeId,
  nodeId,
  info,
  folder = 'attachments',
  onPreviewText,
}: CardProps & { onPreviewText: () => void }) {
  const { t } = useTranslation(['viewer', 'common']);
  const text = useAttachmentText(treeId, nodeId, info.name, info.size, true, folder);
  const parsed = useMemo(
    () => (text.data === undefined ? null : parseCsv(text.data, delimiterFor(info.name))),
    [text.data, info.name],
  );
  if (text.error) return <p className="attachment-note muted small">{errorMessage(text.error)}</p>;
  if (text.data === undefined)
    return <p className="attachment-note muted small">{t('common:loading')}</p>;
  if (!parsed) {
    return (
      <p className="attachment-note muted small">
        {t('couldNotParse')}{' '}
        <button type="button" className="link-btn" onClick={onPreviewText}>
          {t('previewAsText')}
        </button>
      </p>
    );
  }
  return (
    <DataTable
      header={parsed.header}
      rows={parsed.rows}
      baseName={baseNameOf(info.name)}
      collapsedRows={COLLAPSED_ROWS}
      fullFileUrl={nodeFileUrl(folder, treeId, nodeId, info.name, true)}
    />
  );
}

function ImagePreview({
  url,
  info,
  onOpen,
}: {
  url: string;
  info: AttachmentInfo;
  onOpen: () => void;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <BrokenAttachment name={info.name} />;
  return (
    <button
      type="button"
      className={`attachment-thumb attachment-thumb-${info.kind}`}
      onClick={onOpen}
    >
      <img src={url} alt={info.name} loading="lazy" onError={() => setBroken(true)} />
    </button>
  );
}

/** A committed attachment: badge, name, size, Preview / Download, inline preview. */
export function AttachmentCard({ treeId, nodeId, info, folder = 'attachments' }: CardProps) {
  const { t } = useTranslation(['chat', 'common']);
  const openAttachment = useOpenAttachment();
  const url = nodeFileUrl(folder, treeId, nodeId, info.name);
  const previewable = canPreview(info);
  const open = (asText = false) =>
    openAttachment({ treeId, nodeId, attachment: info, folder, ...(asText ? { asText } : {}) });
  const companion = folder === 'files' ? info.text : undefined;
  // The book size is an upper bound of its extracted text for the preview-limit check.
  const openCompanion = (text: string) =>
    openAttachment({
      treeId,
      nodeId,
      folder,
      attachment: {
        name: text,
        kind: 'text',
        contentType: 'text/markdown; charset=utf-8',
        size: info.size,
      },
    });
  const tooLarge =
    (info.kind === 'image' || info.kind === 'svg' || info.kind === 'table') && !previewable;

  return (
    <li className="attachment-card">
      <div className="attachment-row">
        <KindBadge name={info.name} />
        <span className="attachment-name truncate" title={info.name}>
          {info.name}
        </span>
        <span className="attachment-size">{formatBytes(info.size)}</span>
        <span className="spacer" />
        {previewable && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => open()}>
            {t('common:preview')}
          </button>
        )}
        {companion && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => openCompanion(companion)}
          >
            {t('attachments.previewText')}
          </button>
        )}
        <a
          className="btn btn-ghost btn-sm"
          href={nodeFileUrl(folder, treeId, nodeId, info.name, true)}
          download={info.name}
        >
          {t('common:download')}
        </a>
      </div>
      {tooLarge && <p className="attachment-note muted small">{t('attachments.tooLarge')}</p>}
      {previewable && (info.kind === 'image' || info.kind === 'svg') && (
        <ImagePreview url={url} info={info} onOpen={() => open()} />
      )}
      {previewable && info.kind === 'table' && (
        <TablePreview
          treeId={treeId}
          nodeId={nodeId}
          info={info}
          folder={folder}
          onPreviewText={() => open(true)}
        />
      )}
    </li>
  );
}

/** A file of a streaming answer; not fetchable until the answer is saved. */
export function StreamingCard({ item, unsaved }: { item: StreamingAttachment; unsaved: boolean }) {
  const { t } = useTranslation(['chat', 'common']);
  const name =
    item.attachment?.name ??
    item.requestedName ??
    (item.origin === 'url' ? t('attachments.downloading') : t('attachments.attachment'));
  return (
    <li className={`attachment-card attachment-${item.status}`}>
      <div className="attachment-row">
        <KindBadge name={name} />
        <span className="attachment-name truncate" title={name}>
          {name}
        </span>
        {item.attachment && (
          <span className="attachment-size">{formatBytes(item.attachment.size)}</span>
        )}
        <span className="spacer" />
        <span className={`attachment-status attachment-status-${item.status}`}>
          {item.status === 'saving'
            ? unsaved
              ? t('attachments.notSaved')
              : t('attachments.saving')
            : item.status === 'ready'
              ? unsaved
                ? t('attachments.notSaved')
                : t('attachments.readyLater')
              : item.message}
        </span>
      </div>
    </li>
  );
}
