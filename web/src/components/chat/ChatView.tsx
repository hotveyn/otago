import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useChain } from '../../api/queries';
import type { ChainNode, QuestionContext, TreeDetail } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { initialScrollAnchor, nextScrollAnchor } from '../../lib/chat-scroll';
import { stashKeyOf } from '../../lib/draft-stash';
import { useQuestionStore } from '../../lib/question-store';
import { inFlightStatus, MAIN_CONTEXT, pendingLabel } from '../../lib/questions';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { type SelectionAction, SelectionActions } from './SelectionActions';
import { SuggestionList } from './SuggestionList';
import { useComposer } from './useComposer';
import { useInFlight } from './useInFlight';
import { useSuggestions } from './useSuggestions';

interface ChatViewProps {
  tree: TreeDetail;
  currentId: string;
  /** In-flight question shown under `currentId` (`?q=`). */
  question: string | null;
  onSelectNode: (id: string) => void;
  /**
   * Offers "Ask aside" on a selection, anchored on the node the text was selected in;
   * `null` while it is not possible.
   */
  onAskAside: ((text: string, anchor: string) => void) | null;
  /** Move a panel to `parentId` (a "whole" suggestion click). */
  onMoveFocus: (context: QuestionContext, parentId: string) => void;
}

const NO_MESSAGES: ChainNode[] = [];

export function ChatView({
  tree,
  currentId,
  question,
  onSelectNode,
  onAskAside,
  onMoveFocus,
}: ChatViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const chain = useChain(tree.id, currentId);
  const scroller = useRef<HTMLDivElement>(null);
  const inFlight = useInFlight({
    treeId: tree.id,
    context: MAIN_CONTEXT,
    parentId: currentId,
    focus: question,
  });
  const stashKey = stashKeyOf(tree.id, MAIN_CONTEXT);
  const composer = useComposer({
    treeId: tree.id,
    stashKey,
    target: { parentId: currentId, context: MAIN_CONTEXT },
    locked: inFlight.locked,
  });
  const { quote } = composer;

  // Switching nodes scrolls the thread to the selected exchange; following a just-saved
  // answer keeps the reading position (state adjusted during render, see `nextScrollAnchor`).
  const store = useQuestionStore();
  const [anchor, setAnchor] = useState(() => initialScrollAnchor(currentId, question));
  const nextAnchor = nextScrollAnchor(anchor, currentId, question, store.getState().questions);
  if (nextAnchor !== anchor) setAnchor(nextAnchor);

  // Quotes only edit the draft; the message still goes under `currentId`. "Ask aside" branches
  // from the exchange the text was selected in (the chain shows ancestors too).
  const selectionActions = useMemo<SelectionAction[]>(
    () => [
      { id: 'quote', label: t('quote'), run: quote },
      ...(onAskAside
        ? [
            {
              id: 'aside',
              label: t('askAside'),
              run: (text: string, nodeId: string | null) => onAskAside(text, nodeId ?? currentId),
            },
          ]
        : []),
    ],
    [t, quote, onAskAside, currentId],
  );

  const messages = chain.data ?? NO_MESSAGES;
  const view = inFlight.view;
  const status = view ? inFlightStatus(view) : null;
  const focusTitle = view?.kind === 'question' && question !== null ? view.info.title : null;
  // Under the focused saved node only, once its chain is the one shown (not a placeholder).
  const suggestions = useSuggestions({
    treeId: tree.id,
    nodeId: currentId || null,
    context: MAIN_CONTEXT,
    stashKey,
    models: composer.models,
    show: question === null && view === null && messages.at(-1)?.id === currentId && !chain.error,
    onMoveFocus,
  });

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
        scrollKey={nextAnchor.key}
        tail={<SuggestionList items={suggestions.items} onAsk={suggestions.ask} />}
        tailKey={suggestions.items.length}
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
