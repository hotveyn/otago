import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, sendMessage } from '../../api/client';
import { keys, useChain, useModels } from '../../api/queries';
import type { ChainNode, TreeDetail } from '../../api/types';
import { applyAttachmentEvent, type StreamingAttachment } from '../../lib/attachments';
import { appendQuote } from '../../lib/quote';
import { safeStorage } from '../../lib/storage';
import { nameOf } from '../../lib/tree';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { Composer, type ComposerHandle, type ModelChoice } from './Composer';
import { Exchange } from './Exchange';
import { type SelectionAction, SelectionActions } from './SelectionActions';

interface ChatViewProps {
  tree: TreeDetail;
  currentId: string;
  onSelectNode: (id: string) => void;
  onStreamingChange: (streaming: boolean) => void;
}

interface Pending {
  parentId: string;
  question: string;
  answer: string;
  /** Live attachment list from `attachment` SSE events. */
  attachments: StreamingAttachment[];
  error: unknown;
}

const MODELS_KEY = 'otago.models';

function loadModels(): ModelChoice {
  try {
    const parsed = JSON.parse(safeStorage.get(MODELS_KEY) ?? '{}') as Partial<ModelChoice>;
    return { model: parsed.model ?? null, namingModel: parsed.namingModel ?? null };
  } catch {
    return { model: null, namingModel: null };
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function ChatView({ tree, currentId, onSelectNode, onStreamingChange }: ChatViewProps) {
  const queryClient = useQueryClient();
  const chain = useChain(tree.id, currentId);
  const available = useModels();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [models, setModels] = useState<ModelChoice>(loadModels);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const stickToBottom = useRef(true);
  const streaming = pending !== null && pending.error === null;

  // Drop stored choices the server no longer offers.
  const allowed = available.data?.models;
  const choice: ModelChoice = {
    model: models.model && allowed && !allowed.includes(models.model) ? null : models.model,
    namingModel:
      models.namingModel && allowed && !allowed.includes(models.namingModel)
        ? null
        : models.namingModel,
  };

  const changeModels = (next: ModelChoice) => {
    setModels(next);
    safeStorage.set(MODELS_KEY, JSON.stringify(next));
  };

  useEffect(() => () => abort.current?.abort(), []);

  const onScroll = () => {
    const element = scroller.current;
    if (element)
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new content only
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [chain.data, pending?.answer, pending?.error, pending?.attachments.length]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: jump to the end when switching nodes
  useLayoutEffect(() => {
    stickToBottom.current = true;
  }, [currentId]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || abort.current) return;
    const parentId = currentId;
    const controller = new AbortController();
    abort.current = controller;
    stickToBottom.current = true;
    setDraft('');
    setPending({ parentId, question: text, answer: '', attachments: [], error: null });
    onStreamingChange(true);
    let answer = '';
    try {
      const { nodeId, attachments } = await sendMessage({
        treeId: tree.id,
        parentId,
        text,
        model: choice.model ?? undefined,
        namingModel: choice.namingModel ?? undefined,
        signal: controller.signal,
        onChunk: (chunk) => {
          answer += chunk;
          setPending((current) => current && { ...current, answer: current.answer + chunk });
        },
        onAttachment: (event) => {
          setPending(
            (current) =>
              current && {
                ...current,
                attachments: applyAttachmentEvent(current.attachments, event),
              },
          );
        },
      });
      // Show the new node immediately; the refetch replaces it with the stored version.
      const parentChain =
        queryClient.getQueryData<ChainNode[]>(keys.chain(tree.id, parentId)) ?? [];
      queryClient.setQueryData<ChainNode[]>(keys.chain(tree.id, nodeId), [
        ...parentChain,
        {
          id: nodeId,
          name: nameOf(nodeId),
          created: new Date().toISOString(),
          model: choice.model ?? available.data?.defaults.answer ?? '',
          user: text,
          assistant: answer.trim(),
          // Committed before `done`, so they are fetchable right away.
          attachments,
        },
      ]);
      await queryClient.invalidateQueries({ queryKey: keys.tree(tree.id) });
      setPending(null);
      onSelectNode(nodeId);
    } catch (error) {
      setDraft((current) => current || text);
      if (controller.signal.aborted) setPending(null);
      else setPending((current) => current && { ...current, error });
    } finally {
      abort.current = null;
      onStreamingChange(false);
    }
  }, [
    draft,
    currentId,
    tree.id,
    choice.model,
    choice.namingModel,
    queryClient,
    onSelectNode,
    onStreamingChange,
    available.data,
  ]);

  // Quotes only edit the draft; the message still goes under `currentId`.
  const quote = useCallback((text: string) => {
    setDraft((current) => appendQuote(current, text));
    composer.current?.focusEnd();
  }, []);

  const selectionActions = useMemo<SelectionAction[]>(
    () => [{ id: 'quote', label: 'Quote', run: quote }],
    [quote],
  );

  const stop = () => abort.current?.abort();
  const messages = chain.data ?? [];
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

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {chain.error ? (
          <div className="chat-empty">
            <ErrorNote error={chain.error} />
            {chain.error instanceof ApiError && chain.error.status === 404 && (
              <Button size="sm" onClick={() => onSelectNode('')}>
                Go to root
              </Button>
            )}
          </div>
        ) : messages.length === 0 && !showPending ? (
          <div className="chat-empty">
            <p className="empty-title">{tree.title}</p>
            <p className="muted">
              {currentId === '' ? 'Ask anything to start a new branch from the root.' : 'Loading…'}
            </p>
            {tree.instructions && <p className="instructions-preview">{tree.instructions}</p>}
          </div>
        ) : (
          <div className="thread">
            {messages.map((node) => (
              <Exchange
                key={node.id}
                question={node.user}
                answer={node.assistant}
                attachments={{
                  treeId: tree.id,
                  nodeId: node.id,
                  attachments: node.attachments,
                  streaming: null,
                }}
                current={node.id === currentId}
                meta={
                  <>
                    <button
                      type="button"
                      className="node-link"
                      onClick={() => onSelectNode(node.id)}
                    >
                      {node.name}
                    </button>
                    <span className="muted">{formatDate(node.created)}</span>
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
                  treeId: tree.id,
                  nodeId: null,
                  attachments: [],
                  streaming: pending.attachments,
                  unsaved: pending.error !== null,
                }}
                streaming={pending.error === null}
                meta={<span className="muted">{pending.error ? 'Not saved' : 'Answering…'}</span>}
                footer={
                  pending.error ? (
                    <ErrorNote error={pending.error} onDismiss={() => setPending(null)} />
                  ) : null
                }
              />
            )}
          </div>
        )}
      </div>

      <SelectionActions container={scroller} actions={selectionActions} resetKey={currentId} />

      {pendingElsewhere && pending && (
        <div className="chat-notice">
          Answering under <code>{pending.parentId || 'root'}</code>…
          <Button size="sm" variant="ghost" onClick={() => onSelectNode(pending.parentId)}>
            Show
          </Button>
        </div>
      )}

      <Composer
        ref={composer}
        value={draft}
        onChange={setDraft}
        onSend={send}
        onStop={stop}
        streaming={streaming}
        target={currentId}
        models={choice}
        onModelsChange={changeModels}
      />
    </div>
  );
}
