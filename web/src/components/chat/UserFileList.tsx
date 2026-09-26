import { useTranslation } from 'react-i18next';
import type { UserFileInfo } from '../../api/types';
import { formatBytes } from '../../lib/attachments';
import { type ComposerFile, isChatImage } from '../../lib/chat-files';
import { AttachmentCard } from './AttachmentCard';
import { KindBadge } from './AttachmentInline';
import { LocalThumb } from './LocalThumb';

type UserFileListProps =
  | { treeId: string; nodeId: string; files: UserFileInfo[]; pending?: never; unsaved?: never }
  | { pending: ComposerFile[]; unsaved: boolean; treeId?: never; nodeId?: never; files?: never };

/**
 * Files the user attached to a message. Committed files use the server's names and the
 * `files` folder; pending ones are the local files of an in-flight send.
 * Rendered outside `AttachmentScope`: `attachments/<name>` links never resolve against them.
 */
export function UserFileList(props: UserFileListProps) {
  const { t } = useTranslation('chat');
  if (props.pending) {
    if (props.pending.length === 0) return null;
    const status = props.unsaved ? t('attachments.notSaved') : t('attachments.uploading');
    return (
      <ul className="user-files" aria-label={t('composer.attachedFiles')}>
        {props.pending.map((item) => (
          <li
            key={item.id}
            className={
              props.unsaved
                ? 'attachment-card user-file-pending user-file-unsaved'
                : 'attachment-card user-file-pending'
            }
          >
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
              <span className="attachment-status">{status}</span>
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
