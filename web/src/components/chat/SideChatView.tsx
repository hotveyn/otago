import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useChain } from '../../api/queries';
import type { QuestionContext, TreeDetail } from '../../api/types';
import { describeError, isNodeMissing, nodeMissingMessage } from '../../lib/chat-errors';
import { stashKeyOf } from '../../lib/draft-stash';
import { inFlightStatus } from '../../lib/questions';
import { canPromote, sideParent, sideThread } from '../../lib/side-chat';
import type { SideChatState } from '../../lib/url-state';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { IdPath } from '../ui/IdPath';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { type SelectionAction, SelectionActions } from './SelectionActions';
import { useComposer } from './useComposer';
import { useInFlight } from './useInFlight';

export interface SideSeed {
  /** Changes on every "Ask aside", so the same text can be quoted twice. */
  nonce: number;
  text: string;
}

interface SideChatViewProps {
  tree: TreeDetail;
  /** Foreground aside; `side.question` is the in-flight question it shows. */
  side: SideChatState;
  /** Quote to append to the draft; applied once per nonce. */
  seed: SideSeed | null;
  onSeedConsumed?: (nonce: number) => void;
  onPromote: () => void;
  /** Close the panel; a question in flight keeps answering in the background. */
  onClose: () => void;
}

/** A "by the way" chat branching from `side.anchor`; the main chat's focus never moves. */
export function SideChatView({
  tree,
  side,
  seed,
  onSeedConsumed,
  onPromote,
  onClose,
}: SideChatViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const parentId = sideParent(side);
  const context = useMemo<QuestionContext>(
    () => ({ kind: 'side', anchor: side.anchor }),
    [side.anchor],
  );
  const chain = useChain(tree.id, parentId);
  const scroller = useRef<HTMLDivElement>(null);
  const inFlight = useInFlight({ treeId: tree.id, context, parentId, focus: side.question });
  const composer = useComposer({
    treeId: tree.id,
    stashKey: stashKeyOf(tree.id, context),
    target: { parentId, context },
    locked: inFlight.locked,
  });
  const { quote, appendToDraft, discard } = composer;

  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (!seed || applied.current === seed.nonce) return;
    applied.current = seed.nonce;
    appendToDraft(seed.text);
    onSeedConsumed?.(seed.nonce);
  }, [seed, appendToDraft, onSeedConsumed]);

  const selectionActions = useMemo<SelectionAction[]>(
    () => [{ id: 'quote', label: t('quote'), run: quote }],
    [t, quote],
  );

  const messages = useMemo(
    () => sideThread(chain.data ?? [], side.anchor),
    [chain.data, side.anchor],
  );
  const view = inFlight.view;
  const status = view ? inFlightStatus(view) : null;
  const chainMissing = chain.error instanceof ApiError && chain.error.status === 404;
  const promotable = canPromote(side) && !chainMissing;

  // An explicit close forgets the draft of this aside (switching asides keeps it).
  const close = useCallback(() => {
    discard();
    onClose();
  }, [discard, onClose]);

  const closeButton = (
    <Button size="sm" onClick={close}>
      {t('side.close')}
    </Button>
  );

  return (
    <div className="chat">
      <header className="chat-header side-header">
        <span className="side-title">
          <Trans
            t={t}
            i18nKey="side.title"
            values={{ anchor: side.anchor }}
            components={{ code: <IdPath id={side.anchor} /> }}
          />
        </span>
        <span className="side-actions">
          <Button
            size="sm"
            disabled={!promotable}
            title={
              side.head === null
                ? t('side.sendFirst')
                : side.question !== null
                  ? t('side.waitAnswer')
                  : t('side.focusHint')
            }
            onClick={onPromote}
          >
            {t('side.open')}
          </Button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('side.close')}
            title={t('side.close')}
            onClick={close}
          >
            ×
          </button>
        </span>
      </header>

      <ChatThread
        treeId={tree.id}
        messages={messages}
        inFlight={view}
        inFlightActions={inFlight.actions}
        inFlightFooter={(error) => (isNodeMissing(error) ? closeButton : null)}
        currentId={side.question === null ? (side.head ?? undefined) : undefined}
        scrollerRef={scroller}
        scrollKey={side.anchor}
        error={
          chain.error ? (
            <>
              <ErrorNote
                error={chain.error}
                message={chainMissing ? nodeMissingMessage() : describeError(chain.error).message}
              />
              {chainMissing && closeButton}
            </>
          ) : null
        }
        empty={
          <p className="muted">
            {chain.isPending && parentId !== '' ? t('common:loading') : t('side.empty')}
          </p>
        }
      />

      <SelectionActions container={scroller} actions={selectionActions} resetKey={side.head} />

      <Composer
        ref={composer.composer}
        value={composer.draft}
        onChange={composer.setDraft}
        onSend={composer.send}
        onCancel={inFlight.cancel}
        locked={composer.locked}
        lockedStatus={status === 'saving' || status === 'cancelling' ? status : null}
        targetNote={status === 'failed' ? 'failed' : composer.locked ? 'waiting' : null}
        target={parentId}
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
