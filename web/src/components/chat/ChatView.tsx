import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useChain } from '../../api/queries';
import type { ChainNode, TreeDetail } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { stashKeyOf } from '../../lib/draft-stash';
import { inFlightStatus, MAIN_CONTEXT, pendingLabel } from '../../lib/questions';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { type SelectionAction, SelectionActions } from './SelectionActions';
import { useComposer } from './useComposer';
import { useInFlight } from './useInFlight';

interface ChatViewProps {
  tree: TreeDetail;
  currentId: string;
  /** In-flight question shown under `currentId` (`?q=`). */
  question: string | null;
  onSelectNode: (id: string) => void;
  /** Offers "Ask aside" on a selection; `null` while it is not possible. */
  onAskAside: ((text: string) => void) | null;
}

const NO_MESSAGES: ChainNode[] = [];

export function ChatView({ tree, currentId, question, onSelectNode, onAskAside }: ChatViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const chain = useChain(tree.id, currentId);
  const scroller = useRef<HTMLDivElement>(null);
  const inFlight = useInFlight({
    treeId: tree.id,
    context: MAIN_CONTEXT,
    parentId: currentId,
    focus: question,
  });
  const composer = useComposer({
    treeId: tree.id,
    stashKey: stashKeyOf(tree.id, MAIN_CONTEXT),
    target: { parentId: currentId, context: MAIN_CONTEXT },
    locked: inFlight.locked,
  });
  const { quote } = composer;

  // Quotes only edit the draft; the message still goes under `currentId`.
  const selectionActions = useMemo<SelectionAction[]>(
    () => [
      { id: 'quote', label: t('quote'), run: quote },
      ...(onAskAside ? [{ id: 'aside', label: t('askAside'), run: onAskAside }] : []),
    ],
    [t, quote, onAskAside],
  );

  const messages = chain.data ?? NO_MESSAGES;
  const view = inFlight.view;
  const status = view ? inFlightStatus(view) : null;
  const focusTitle = view?.kind === 'question' && question !== null ? view.info.title : null;

  return (
    <div className="chat">
      <header className="chat-header">
        <div className="crumbs">
          <button type="button" className="crumb" dir="auto" onClick={() => onSelectNode('')}>
            {tree.title}
          </button>
          {messages.map((node) => (
            <span key={node.id} className="crumb-wrap">
              <span className="crumb-sep">/</span>
              <button
                type="button"
                dir="auto"
                className={node.id === currentId && !question ? 'crumb crumb-current' : 'crumb'}
                onClick={() => onSelectNode(node.id)}
              >
                {node.name}
              </button>
            </span>
          ))}
          {focusTitle !== null && (
            <span className="crumb-wrap">
              <span className="crumb-sep">/</span>
              <span className="crumb crumb-pending" dir="auto" title={focusTitle}>
                {pendingLabel(focusTitle)}
              </span>
            </span>
          )}
        </div>
      </header>

      <ChatThread
        treeId={tree.id}
        messages={messages}
        inFlight={view}
        inFlightActions={inFlight.actions}
        currentId={question ? undefined : currentId}
        onSelectNode={onSelectNode}
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

      <Composer
        ref={composer.composer}
        value={composer.draft}
        onChange={composer.setDraft}
        onSend={composer.send}
        onCancel={inFlight.cancel}
        locked={composer.locked}
        lockedStatus={status === 'saving' || status === 'cancelling' ? status : null}
        targetNote={status === 'failed' ? 'failed' : composer.locked ? 'waiting' : null}
        target={currentId}
        models={composer.models}
        onModelsChange={composer.changeModels}
        files={composer.files}
        fileErrors={composer.fileErrors}
        onAddFiles={composer.addFiles}
        onRemoveFile={composer.removeFile}
        onDismissFileErrors={composer.dismissFileErrors}
        canSend={composer.canSend}
      />
    </div>
  );
}
