import { useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useChain } from '../../api/queries';
import type { ChainNode, TreeDetail } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { type SelectionAction, SelectionActions } from './SelectionActions';
import { useChatSession } from './useChatSession';

interface ChatViewProps {
  tree: TreeDetail;
  currentId: string;
  onSelectNode: (id: string) => void;
  onStreamingChange: (streaming: boolean) => void;
  /** Offers "Ask aside" on a selection. */
  onAskAside?: (text: string) => void;
  /** False hides "Ask aside" (e.g. while the side chat streams). */
  askAsideEnabled?: boolean;
}

const NO_MESSAGES: ChainNode[] = [];

export function ChatView({
  tree,
  currentId,
  onSelectNode,
  onStreamingChange,
  onAskAside,
  askAsideEnabled = true,
}: ChatViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const chain = useChain(tree.id, currentId);
  const scroller = useRef<HTMLDivElement>(null);
  const session = useChatSession({
    treeId: tree.id,
    parentId: currentId,
    onSent: onSelectNode,
    onStreamingChange,
  });
  const { pending, streaming, quote } = session;

  // Quotes only edit the draft; the message still goes under `currentId`.
  const selectionActions = useMemo<SelectionAction[]>(
    () => [
      { id: 'quote', label: t('quote'), run: quote },
      ...(onAskAside && askAsideEnabled
        ? [{ id: 'aside', label: t('askAside'), run: onAskAside }]
        : []),
    ],
    [t, quote, onAskAside, askAsideEnabled],
  );

  const messages = chain.data ?? NO_MESSAGES;
  const showPending = pending !== null && pending.parentId === currentId;
  const pendingElsewhere = pending !== null && pending.parentId !== currentId && streaming;

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="crumbs">
          <button type="button" className="crumb" onClick={() => onSelectNode('')}>
            {tree.title}
          </button>
          {messages.map((node) => (
            <span key={node.id} className="crumb-wrap">
              <span className="crumb-sep">/</span>
              <button
                type="button"
                className={node.id === currentId ? 'crumb crumb-current' : 'crumb'}
                onClick={() => onSelectNode(node.id)}
              >
                {node.name}
              </button>
            </span>
          ))}
        </div>
      </header>

      <ChatThread
        treeId={tree.id}
        messages={messages}
        pending={pending}
        showPending={showPending}
        currentId={currentId}
        onSelectNode={onSelectNode}
        onDismissError={session.dismissError}
        scrollerRef={scroller}
        scrollKey={currentId}
        error={
          chain.error ? (
            <>
              <ErrorNote error={chain.error} message={describeError(chain.error).message} />
              {chain.error instanceof ApiError && chain.error.status === 404 && (
                <Button size="sm" onClick={() => onSelectNode('')}>
                  {t('goToRoot')}
                </Button>
              )}
            </>
          ) : null
        }
        empty={
          <>
            <p className="empty-title">{tree.title}</p>
            <p className="muted">{currentId === '' ? t('emptyRoot') : t('common:loading')}</p>
            {tree.instructions && <p className="instructions-preview">{tree.instructions}</p>}
          </>
        }
      />

      <SelectionActions container={scroller} actions={selectionActions} resetKey={currentId} />

      {pendingElsewhere && pending && (
        <div className="chat-notice">
          <Trans
            t={t}
            i18nKey="answeringUnder"
            values={{ target: pending.parentId || t('common:root') }}
            components={{ code: <code /> }}
          />
          <Button size="sm" variant="ghost" onClick={() => onSelectNode(pending.parentId)}>
            {t('show')}
          </Button>
        </div>
      )}

      <Composer
        ref={session.composer}
        value={session.draft}
        onChange={session.setDraft}
        onSend={session.send}
        onStop={session.stop}
        streaming={streaming}
        target={currentId}
        models={session.models}
        onModelsChange={session.changeModels}
        files={session.files}
        fileErrors={session.fileErrors}
        onAddFiles={session.addFiles}
        onRemoveFile={session.removeFile}
        onDismissFileErrors={session.dismissFileErrors}
        canSend={session.canSend}
      />
    </div>
  );
}
