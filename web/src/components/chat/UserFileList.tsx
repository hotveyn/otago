import { useTranslation } from 'react-i18next';
import type { UserFileInfo } from '../../api/types';
import { formatBytes } from '../../lib/attachments';
import { type ComposerFile, isChatImage } from '../../lib/chat-files';
import { AttachmentCard } from './AttachmentCard';
import { KindBadge } from './AttachmentInline';
import { LocalThumb } from './LocalThumb';

/** State of the files of an in-flight message. */
export type InFlightFileStatus = 'uploading' | 'notSaved' | 'attached' | 'keptForRetry';

type UserFileListProps =
  | {
      treeId: string;
      nodeId: string;
      files: UserFileInfo[];
      pending?: never;
      staged?: never;
      status?: never;
    }
  | {
      /** Local files of a send of this tab (thumbnails). */
      pending: ComposerFile[];
      status: InFlightFileStatus;
      treeId?: never;
      nodeId?: never;
      files?: never;
      staged?: never;
    }
  | {
      /** Server metadata of an in-flight question's files (not fetchable before it is saved). */
      staged: UserFileInfo[];
      status: 'attached' | 'keptForRetry';
      treeId?: never;
      nodeId?: never;
      files?: never;
      pending?: never;
    };

function useStatusText(status: InFlightFileStatus): string {
  const { t } = useTranslation('chat');
  switch (status) {
    case 'uploading':
      return t('attachments.uploading');
    case 'notSaved':
      return t('attachments.notSaved');
    case 'attached':
      return t('attachments.attached');
    case 'keptForRetry':
      return t('attachments.keptForRetry');
    default:
      return '';
  }
}

const rowClass = (status: InFlightFileStatus) =>
  status === 'notSaved'
    ? 'attachment-card user-file-pending user-file-unsaved'
    : 'attachment-card user-file-pending';

/**
 * Files the user attached to a message. Committed files use the server's names and the
 * `files` folder; in-flight ones are this tab's local files or the server's staged metadata.
 * Rendered outside `AttachmentScope`: `attachments/<name>` links never resolve against them.
 */
export function UserFileList(props: UserFileListProps) {
  const { t } = useTranslation('chat');
  const statusText = useStatusText(props.status ?? 'attached');
  if (props.pending) {
    if (props.pending.length === 0) return null;
    return (
      <ul className="user-files" aria-label={t('composer.attachedFiles')}>
        {props.pending.map((item) => (
          <li key={item.id} className={rowClass(props.status)}>
            <div className="attachment-row">
              <KindBadge name={item.file.name} />
              {isChatImage(item.file) && (
                <LocalThumb file={item.file} className="composer-file-thumb" />
              )}
              <span className="attachment-name truncate" title={item.file.name}>
                {item.file.name}
              </span>
              <span className="attachment-size">{formatBytes(item.file.size)}</span>
              <span className="spacer" />
              <span className="attachment-status">{statusText}</span>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (props.staged) {
    if (props.staged.length === 0) return null;
    return (
      <ul className="user-files" aria-label={t('composer.attachedFiles')}>
        {props.staged.map((info) => (
          <li key={info.name} className={rowClass(props.status)}>
            <div className="attachment-row">
              <KindBadge name={info.name} />
              <span className="attachment-name truncate" title={info.name}>
                {info.name}
              </span>
              <span className="attachment-size">{formatBytes(info.size)}</span>
              <span className="spacer" />
              <span className="attachment-status">{statusText}</span>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  const { treeId, nodeId, files } = props;
  if (files.length === 0) return null;
  return (
    <ul className="user-files" aria-label={t('composer.attachedFiles')}>
      {files.map((info) => (
        <AttachmentCard
          key={info.name}
          treeId={treeId}
          nodeId={nodeId}
          info={info}
          folder="files"
        />
      ))}
    </ul>
  );
}
