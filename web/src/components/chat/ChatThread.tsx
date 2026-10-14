import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChainNode } from '../../api/types';
import { type InFlightView, inFlightStatus } from '../../lib/questions';
import { Exchange } from './Exchange';
import { type InFlightActions, InFlightExchange } from './InFlightExchange';
import { UserFileList } from './UserFileList';

interface ChatThreadProps {
  treeId: string;
  messages: ChainNode[];
  /** The panel's in-flight exchange (its focused question or its send), shown last. */
  inFlight: InFlightView | null;
  inFlightActions?: InFlightActions;
  /** Extra content under a "Not sent" failure. */
  inFlightFooter?: (error: unknown) => ReactNode;
  currentId?: string;
  /** Makes node names links; plain text when absent. */
  onSelectNode?: (id: string) => void;
  /** Shown when there are no messages and nothing in flight. */
  empty: ReactNode;
  /** Shown instead of the thread (e.g. a chain load error). */
  error: ReactNode | null;
  scrollerRef: RefObject<HTMLDivElement | null>;
  /**
   * Changing it scrolls to the start of the current exchange (switching nodes), or to the end
   * when there is no current exchange.
   */
  scrollKey: unknown;
}

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

type Jump = 'current' | 'bottom' | null;

const isAtBottom = (element: HTMLElement): boolean =>
  element.scrollHeight - element.scrollTop - element.clientHeight < 80;

/** Scroll offset that puts `target` at the top of `scroller`. */
const offsetWithin = (target: HTMLElement, scroller: HTMLElement): number =>
  target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

const inFlightKey = (view: InFlightView | null): string | null => {
  if (!view) return null;
  if (view.kind === 'outbox') return view.entry.id;
  if (view.kind === 'question') return view.info.id;
  return view.id;
};

/** Scrollable message list of a chat panel, including the in-flight exchange. */
export function ChatThread({
  treeId,
  messages,
  inFlight,
  inFlightActions,
  inFlightFooter,
  currentId,
  onSelectNode,
  empty,
  error,
  scrollerRef,
  scrollKey,
}: ChatThreadProps) {
  const { i18n } = useTranslation('chat');
  const stickToBottom = useRef(true);
  /** Pending jump, applied once the content it targets is rendered. */
  const jump = useRef<Jump>(null);
  const key = inFlightKey(inFlight);
  const stream = inFlight?.kind === 'question' ? inFlight.stream : null;
  const status = inFlight ? inFlightStatus(inFlight) : null;

  const onScroll = () => {
    const element = scrollerRef.current;
    if (element) stickToBottom.current = isAtBottom(element);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching nodes shows the selected exchange from its start
  useLayoutEffect(() => {
    jump.current = currentId === undefined ? 'bottom' : 'current';
  }, [scrollKey]);

  // A new send / focused question shows at the end.
  useLayoutEffect(() => {
    if (key !== null) jump.current = 'bottom';
  }, [key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content only
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    if (jump.current === 'current') {
      // The chain may still be loading (or be the previous one): wait for the exchange.
      const target = element.querySelector<HTMLElement>('.exchange-current');
      if (!target) return;
      element.scrollTop = offsetWithin(target, element);
      jump.current = null;
      stickToBottom.current = isAtBottom(element);
      return;
    }
    if (jump.current === 'bottom') {
      jump.current = null;
      stickToBottom.current = true;
    }
    if (stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages, key, stream?.text.length, stream?.attachments.length, status]);

  return (
    <div className="chat-scroll" ref={scrollerRef} onScroll={onScroll}>
      {error ? (
        <div className="chat-empty">{error}</div>
      ) : messages.length === 0 && !inFlight ? (
        <div className="chat-empty">{empty}</div>
      ) : (
        <div className="thread">
          {messages.map((node) => (
            <Exchange
              key={node.id}
              nodeId={node.id}
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
                      dir="auto"
                      onClick={() => onSelectNode(node.id)}
                    >
                      {node.name}
                    </button>
                  ) : (
                    <span dir="auto">{node.name}</span>
                  )}
                  <span className="muted">{formatDate(node.created, i18n.language)}</span>
                  {node.model && <span className="model-tag">{node.model}</span>}
                </>
              }
            />
          ))}
          {inFlight && (
            <InFlightExchange
              key={key ?? undefined}
              treeId={treeId}
              view={inFlight}
              actions={inFlightActions}
              footer={inFlightFooter}
            />
          )}
        </div>
      )}
    </div>
  );
}
