import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChainNode } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { ErrorNote } from '../ui/ErrorNote';
import { Exchange } from './Exchange';
import { UserFileList } from './UserFileList';
import type { Pending } from './useChatSession';

interface ChatThreadProps {
  treeId: string;
  messages: ChainNode[];
  pending: Pending | null;
  /** The pending exchange belongs to what this thread shows. */
  showPending: boolean;
  currentId?: string;
  /** Makes node names links; plain text when absent. */
  onSelectNode?: (id: string) => void;
  onDismissError: () => void;
  /** Shown when there are no messages and nothing pending. */
  empty: ReactNode;
  /** Shown instead of the thread (e.g. a chain load error). */
  error: ReactNode | null;
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Changing it jumps back to the end (e.g. switching nodes). */
  scrollKey: unknown;
  /** Extra content under a failed pending exchange. */
  pendingFooter?: (error: unknown) => ReactNode;
  /** Text for a failed pending exchange; defaults to `describeError`. */
  errorText?: (error: unknown) => string;
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Scrollable message list of a chat panel, including the in-flight exchange. */
export function ChatThread({
  treeId,
  messages,
  pending,
  showPending,
  currentId,
  onSelectNode,
  onDismissError,
  empty,
  error,
  scrollerRef,
  scrollKey,
  pendingFooter,
  errorText = (failure) => describeError(failure).message,
}: ChatThreadProps) {
  const { t, i18n } = useTranslation('chat');
  const stickToBottom = useRef(true);

  const onScroll = () => {
    const element = scrollerRef.current;
    if (element)
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: jump to the end when switching nodes or sending
  useLayoutEffect(() => {
    stickToBottom.current = true;
  }, [scrollKey, pending?.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content only
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages, pending?.answer, pending?.error, pending?.attachments.length, pending?.phase]);

  return (
    <div className="chat-scroll" ref={scrollerRef} onScroll={onScroll}>
      {error ? (
        <div className="chat-empty">{error}</div>
      ) : messages.length === 0 && !showPending ? (
        <div className="chat-empty">{empty}</div>
      ) : (
        <div className="thread">
          {messages.map((node) => (
            <Exchange
              key={node.id}
              question={node.user}
              answer={node.assistant}
              attachments={{
                treeId,
                nodeId: node.id,
                attachments: node.attachments,
                streaming: null,
              }}
              current={node.id === currentId}
              files={
                node.files.length > 0 ? (
                  <UserFileList treeId={treeId} nodeId={node.id} files={node.files} />
                ) : undefined
              }
              meta={
                <>
                  {onSelectNode ? (
                    <button
                      type="button"
                      className="node-link"
                      onClick={() => onSelectNode(node.id)}
                    >
                      {node.name}
                    </button>
                  ) : (
                    <span>{node.name}</span>
                  )}
                  <span className="muted">{formatDate(node.created, i18n.language)}</span>
                  {node.model && <span className="model-tag">{node.model}</span>}
                </>
              }
            />
          ))}
          {showPending && pending && (
            <Exchange
              question={pending.question}
              answer={pending.answer}
              attachments={{
                treeId,
                nodeId: null,
                attachments: [],
                streaming: pending.attachments,
                unsaved: pending.error !== null,
              }}
              streaming={pending.error === null}
              files={
                pending.files.length > 0 ? (
                  <UserFileList pending={pending.files} unsaved={pending.error !== null} />
                ) : undefined
              }
              meta={
                <span className="muted">
                  {pending.error
                    ? t('notSaved')
                    : pending.phase === 'uploading'
                      ? t('uploadingFiles')
                      : t('answering')}
                </span>
              }
              footer={
                pending.error ? (
                  <>
                    <ErrorNote
                      error={pending.error}
                      message={errorText(pending.error)}
                      onDismiss={onDismissError}
                    />
                    {pendingFooter?.(pending.error)}
                  </>
                ) : null
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
