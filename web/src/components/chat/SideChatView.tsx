import { useEffect, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useChain } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { describeError, isNodeMissing, nodeMissingMessage } from '../../lib/chat-errors';
import { canPromote, sideParent, sideThread } from '../../lib/side-chat';
import { nameOf } from '../../lib/tree';
import type { SideChatState } from '../../lib/url-state';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { type SelectionAction, SelectionActions } from './SelectionActions';
import { useChatSession } from './useChatSession';

export interface SideSeed {
  /** Changes on every "Ask aside", so the same text can be quoted twice. */
  nonce: number;
  text: string;
}

interface SideChatViewProps {
  tree: TreeDetail;
  side: SideChatState;
  /** Quote to append to the draft; applied once per nonce. */
  seed: SideSeed | null;
  onSeedConsumed?: (nonce: number) => void;
  /** A side send created `nodeId`. */
  onAdvance: (nodeId: string) => void;
  onPromote: () => void;
  onClose: () => void;
  onStreamingChange: (streaming: boolean) => void;
}

const sideErrorText = (error: unknown) =>
  isNodeMissing(error) ? nodeMissingMessage() : describeError(error).message;

/** A "by the way" chat branching from `side.anchor`; the main chat's focus never moves. */
export function SideChatView({
  tree,
  side,
  seed,
  onSeedConsumed,
  onAdvance,
  onPromote,
  onClose,
  onStreamingChange,
}: SideChatViewProps) {
  const { t } = useTranslation(['chat', 'common']);
  const parentId = sideParent(side);
  const chain = useChain(tree.id, parentId);
  const scroller = useRef<HTMLDivElement>(null);
  const session = useChatSession({
    treeId: tree.id,
    parentId,
    onSent: onAdvance,
    onStreamingChange,
  });
  const { pending, streaming, quote, appendToDraft } = session;

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
  const showPending = pending !== null && pending.parentId === parentId;
  const chainMissing = chain.error instanceof ApiError && chain.error.status === 404;
  const promotable = canPromote(side, streaming) && !chainMissing;
  const anchorName = side.anchor === '' ? t('common:root') : nameOf(side.anchor);

  const closeButton = (
    <Button size="sm" onClick={onClose}>
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
            values={{ anchor: anchorName }}
            components={{ code: <code /> }}
          />
        </span>
        <span className="side-actions">
          <Button
            size="sm"
            disabled={!promotable}
            title={
              side.head === null
                ? t('side.sendFirst')
                : streaming
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
            onClick={onClose}
          >
            ×
          </button>
        </span>
      </header>

      <ChatThread
        treeId={tree.id}
        messages={messages}
        pending={pending}
        showPending={showPending}
        currentId={side.head ?? undefined}
        onDismissError={session.dismissError}
        scrollerRef={scroller}
        scrollKey={side.anchor}
        errorText={sideErrorText}
        pendingFooter={(error) => (isNodeMissing(error) ? closeButton : null)}
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
        ref={session.composer}
        value={session.draft}
        onChange={session.setDraft}
        onSend={session.send}
        onStop={session.stop}
        streaming={streaming}
        target={parentId}
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
