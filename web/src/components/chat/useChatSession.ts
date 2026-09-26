import { useQueryClient } from '@tanstack/react-query';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sendMessage } from '../../api/client';
import { keys, useModels } from '../../api/queries';
import type { ChainNode } from '../../api/types';
import { applyAttachmentEvent, type StreamingAttachment } from '../../lib/attachments';
import {
  type ComposerFile,
  canSend as canSendMessage,
  type RejectedFile,
  restoreFiles,
  toComposerFiles,
  validateChatFiles,
} from '../../lib/chat-files';
import { appendQuote } from '../../lib/quote';
import { safeStorage } from '../../lib/storage';
import { nameOf } from '../../lib/tree';
import type { ComposerHandle, ModelChoice } from './Composer';

export interface Pending {
  /** Distinct per send, so views can react to a new exchange starting. */
  id: number;
  parentId: string;
  question: string;
  answer: string;
  /** Live attachment list from `attachment` SSE events. */
  attachments: StreamingAttachment[];
  /** Snapshot of the files that were sent (local names; the server may rename them). */
  files: ComposerFile[];
  /** `uploading` until the server accepted the files (only when files were sent). */
  phase: 'uploading' | 'answering';
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

export interface ChatSessionOptions {
  treeId: string;
  /** Parent of the next message; read at send time. */
  parentId: string;
  /** A message was stored as `nodeId` (after the tree refetch). */
  onSent: (nodeId: string) => void;
  onStreamingChange: (streaming: boolean) => void;
}

export interface ChatSession {
  draft: string;
  setDraft: (draft: string) => void;
  pending: Pending | null;
  streaming: boolean;
  composer: RefObject<ComposerHandle | null>;
  models: ModelChoice;
  changeModels: (next: ModelChoice) => void;
  send: () => Promise<void>;
  stop: () => void;
  /** Append a `> ` quote to the draft and focus the composer. */
  quote: (text: string) => void;
  /** Same as `quote`; used to seed a draft from outside the panel. */
  appendToDraft: (text: string) => void;
  dismissError: () => void;
  /** Files waiting in the composer for the next send. */
  files: ComposerFile[];
  /** Files the last add refused, with reasons. */
  fileErrors: RejectedFile[];
  addFiles: (files: File[]) => void;
  removeFile: (id: number) => void;
  dismissFileErrors: () => void;
  /** Text or files present and nothing streaming. */
  canSend: boolean;
}

let nextPendingId = 1;

/**
 * Draft, streaming send, pending exchange and model choice of one chat panel.
 *
 * The model choice is per instance but shares one localStorage key, so a change in one
 * panel reaches another panel only when it remounts.
 */
export function useChatSession(options: ChatSessionOptions): ChatSession {
  const { treeId } = options;
  const queryClient = useQueryClient();
  const available = useModels();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [files, setFilesState] = useState<ComposerFile[]>([]);
  // Latest list, updated synchronously so back-to-back adds validate against each other.
  const filesRef = useRef<ComposerFile[]>([]);
  const setFiles = useCallback((next: ComposerFile[]) => {
    filesRef.current = next;
    setFilesState(next);
  }, []);
  const [fileErrors, setFileErrors] = useState<RejectedFile[]>([]);
  const [models, setModels] = useState<ModelChoice>(loadModels);
  const abort = useRef<AbortController | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const streaming = pending !== null && pending.error === null;

  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  // Drop stored choices the server no longer offers.
  const allowed = available.data?.models;
  const choice: ModelChoice = {
    model: models.model && allowed && !allowed.includes(models.model) ? null : models.model,
    namingModel:
      models.namingModel && allowed && !allowed.includes(models.namingModel)
        ? null
        : models.namingModel,
  };

  const changeModels = useCallback((next: ModelChoice) => {
    setModels(next);
    safeStorage.set(MODELS_KEY, JSON.stringify(next));
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  const addFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      const current = filesRef.current;
      const { accepted, rejected } = validateChatFiles(current, incoming);
      if (accepted.length) setFiles([...current, ...toComposerFiles(accepted)]);
      setFileErrors(rejected);
    },
    [setFiles],
  );

  const removeFile = useCallback(
    (id: number) => setFiles(filesRef.current.filter((item) => item.id !== id)),
    [setFiles],
  );
  const dismissFileErrors = useCallback(() => setFileErrors([]), []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!canSendMessage(text, files, abort.current !== null)) return;
    const sent = files;
    const { parentId, onStreamingChange } = latest.current;
    const controller = new AbortController();
    abort.current = controller;
    setDraft('');
    setFiles([]);
    setFileErrors([]);
    setPending({
      id: nextPendingId++,
      parentId,
      question: text,
      answer: '',
      attachments: [],
      files: sent,
      phase: sent.length ? 'uploading' : 'answering',
      error: null,
    });
    onStreamingChange(true);
    let answer = '';
    try {
      const done = await sendMessage({
        treeId,
        parentId,
        text,
        model: choice.model ?? undefined,
        namingModel: choice.namingModel ?? undefined,
        files: sent.map((item) => item.file),
        signal: controller.signal,
        onAccepted: () => setPending((current) => current && { ...current, phase: 'answering' }),
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
      const { nodeId, attachments } = done;
      // Show the new node immediately; the refetch replaces it with the stored version.
      const parentChain = queryClient.getQueryData<ChainNode[]>(keys.chain(treeId, parentId)) ?? [];
      queryClient.setQueryData<ChainNode[]>(keys.chain(treeId, nodeId), [
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
          // The server's stored names, never the local ones.
          files: done.files,
        },
      ]);
      await queryClient.invalidateQueries({ queryKey: keys.tree(treeId) });
      setPending(null);
      latest.current.onSent(nodeId);
    } catch (error) {
      setDraft((current) => current || text);
      setFiles(restoreFiles(filesRef.current, sent));
      if (controller.signal.aborted) setPending(null);
      else setPending((current) => current && { ...current, error });
    } finally {
      abort.current = null;
      latest.current.onStreamingChange(false);
    }
  }, [
    draft,
    files,
    setFiles,
    treeId,
    choice.model,
    choice.namingModel,
    queryClient,
    available.data,
  ]);

  const quote = useCallback((text: string) => {
    setDraft((current) => appendQuote(current, text));
    composer.current?.focusEnd();
  }, []);

  const stop = useCallback(() => abort.current?.abort(), []);
  const dismissError = useCallback(() => setPending(null), []);

  return {
    draft,
    setDraft,
    pending,
    streaming,
    composer,
    models: choice,
    changeModels,
    send,
    stop,
    quote,
    appendToDraft: quote,
    dismissError,
    files,
    fileErrors,
    addFiles,
    removeFile,
    dismissFileErrors,
    canSend: canSendMessage(draft, files, streaming),
  };
}
