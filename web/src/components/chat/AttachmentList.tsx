import { useTranslation } from 'react-i18next';
import { AttachmentCard, StreamingCard } from './AttachmentCard';
import { useAttachmentScope } from './attachment-scope';

/** Every attachment of the answer, under its text. Renders nothing when there are none. */
export function AttachmentList() {
  const { t } = useTranslation('chat');
  const scope = useAttachmentScope();
  if (!scope) return null;
  const { treeId, nodeId, attachments, streaming } = scope;

  if (nodeId !== null) {
    if (attachments.length === 0) return null;
    return (
      <aside className="attachments">
        <h4>{t('attachments.heading', { count: attachments.length })}</h4>
        <ul>
          {attachments.map((info) => (
            <AttachmentCard key={info.name} treeId={treeId} nodeId={nodeId} info={info} />
          ))}
        </ul>
      </aside>
    );
  }

  if (!streaming || streaming.length === 0) return null;
  return (
    <aside className="attachments">
      <h4>{t('attachments.heading', { count: streaming.length })}</h4>
      <ul>
        {streaming.map((item) => (
          <StreamingCard key={item.key} item={item} unsaved={scope.unsaved ?? false} />
        ))}
      </ul>
    </aside>
  );
}
