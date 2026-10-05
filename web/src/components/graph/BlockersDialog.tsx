import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  type BlockerItem,
  type BlockersOpened,
  blockerList,
  blockerListEqual,
} from '../../lib/blockers';
import { describeError } from '../../lib/chat-errors';
import { useQuestionStore, useStoreSelector } from '../../lib/question-store';
import { pendingLabel } from '../../lib/questions';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ErrorNote } from '../ui/ErrorNote';
import { IdPath } from '../ui/IdPath';

interface BlockersDialogProps {
  tree: string;
  /** Server details and store generation taken when the dialog opened. */
  opened: BlockersOpened;
  /** The refused action, enabled once nothing blocks it. */
  retry?: { label: string; run: () => void };
  onClose: () => void;
  onOpenQuestion: (id: string) => void;
}

/**
 * Which answers block structural edits of the tree (a 409 `tree_busy_streaming`, or the busy
 * toolbar). Live: rows disappear as answers finish; Cancel / Cancel all stop them, and the
 * refused action can be run again from here.
 */
export function BlockersDialog({
  tree,
  opened,
  retry,
  onClose,
  onOpenQuestion,
}: BlockersDialogProps) {
  const { t } = useTranslation(['graph', 'common']);
  const store = useQuestionStore();
  const list = useStoreSelector((state) => blockerList(state, tree, opened), blockerListEqual, [
    tree,
    opened,
  ]);
  const [error, setError] = useState<unknown>(null);
  const cancellable = list.items.filter((item) => item.status === 'streaming' && !item.cancelling);
  const clear = list.items.length === 0 && list.uploading === 0;

  const cancel = (id: string) => {
    setError(null);
    store.cancel(id).catch(setError);
  };
  const cancelAll = () => {
    setError(null);
    void Promise.allSettled(cancellable.map((item) => store.cancel(item.id))).then((results) => {
      const failed = results.find((outcome) => outcome.status === 'rejected');
      if (failed) setError(failed.reason);
    });
  };

  const statusOf = (item: BlockerItem) =>
    item.status === 'naming'
      ? t('blockers.saving')
      : item.cancelling
        ? t('pending.cancelling')
        : t('pending.streaming');

  return (
    <Dialog
      open
      wide
      title={t('blockers.title')}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" disabled={cancellable.length === 0} onClick={cancelAll}>
            {t('blockers.cancelAll')}
          </Button>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            {t('common:close')}
          </Button>
          {retry && (
            <Button
              variant="primary"
              disabled={!clear}
              onClick={() => {
                onClose();
                retry.run();
              }}
            >
              {retry.label}
            </Button>
          )}
        </>
      }
    >
      {list.items.length > 0 ? (
        <p>{t('blockers.body', { count: list.items.length })}</p>
      ) : (
        <p className="muted">{t('blockers.none')}</p>
      )}
      {list.items.length > 0 && (
        <ul className="blocker-list">
          {list.items.map((item) => (
            <li key={item.id} className="blocker">
              <div className="blocker-main">
                <span className="blocker-title" dir="auto" title={item.title}>
                  {pendingLabel(item.title)}
                </span>
                <span className="muted small">
                  <Trans
                    t={t}
                    i18nKey="blockers.under"
                    values={{ parent: item.parentId }}
                    components={{ code: <IdPath id={item.parentId} /> }}
                  />
                  {item.context.kind === 'side' && (
                    <span className="blocker-tag">{t('blockers.aside')}</span>
                  )}
                  {' · '}
                  {statusOf(item)}
                </span>
              </div>
              <div className="blocker-actions">
                {item.source === 'store' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onOpenQuestion(item.id);
                      onClose();
                    }}
                  >
                    {t('blockers.open')}
                  </Button>
                )}
                {item.status === 'streaming' && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={item.cancelling}
                    onClick={() => cancel(item.id)}
                  >
                    {t('blockers.cancel')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.preparing > 0 && (
        <p className="muted small">{t('blockers.preparing', { count: list.preparing })}</p>
      )}
      {list.uploading > 0 && (
        <p className="muted small">{t('blockers.uploading', { count: list.uploading })}</p>
      )}
      <ErrorNote
        error={error}
        message={describeError(error).message}
        onDismiss={() => setError(null)}
      />
    </Dialog>
  );
}
