import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useModels } from '../../api/queries';
import type { QuestionContext } from '../../api/types';
import {
  type ComposerFile,
  canSend as canSendMessage,
  type RejectedFile,
  restoreFiles,
  toComposerFiles,
  validateChatFiles,
} from '../../lib/chat-files';
import { draftStash } from '../../lib/draft-stash';
import { type OutboxEnd, useQuestionStore } from '../../lib/question-store';
import { sameContext } from '../../lib/questions';
import { appendQuote } from '../../lib/quote';
import { safeStorage } from '../../lib/storage';
import type { ComposerHandle, ModelChoice } from './Composer';

const MODELS_KEY = 'otago.models';

function loadModels(): ModelChoice {
  try {
    const parsed = JSON.parse(safeStorage.get(MODELS_KEY) ?? '{}') as Partial<ModelChoice>;
    return { model: parsed.model ?? null, namingModel: parsed.namingModel ?? null };
  } catch {
    return { model: null, namingModel: null };
  }
}

/** Where a panel's next message goes. */
export interface ComposerTarget {
  parentId: string;
  context: QuestionContext;
}

export interface ComposerOptions {
  treeId: string;
  /** Draft stash key of this panel (`stashKeyOf`). */
  stashKey: string;
  /** Where this panel sends; read at send time and when a send fails. */
  target: ComposerTarget;
  /** The panel shows an in-flight or failed question: nothing can be sent. */
  locked: boolean;
}

export interface ComposerState {
  draft: string;
  setDraft: (draft: string) => void;
  composer: RefObject<ComposerHandle | null>;
  models: ModelChoice;
  changeModels: (next: ModelChoice) => void;
  send: () => void;
  /** Append a `> ` quote to the draft and focus the composer. */
  quote: (text: string) => void;
  /** Same as `quote`; used to seed a draft from outside the panel. */
  appendToDraft: (text: string) => void;
  /** Files waiting in the composer for the next send. */
  files: ComposerFile[];
  /** Files the last add refused, with reasons. */
  fileErrors: RejectedFile[];
  addFiles: (files: File[]) => void;
  removeFile: (id: number) => void;
  dismissFileErrors: () => void;
  /** Forget the draft for good (the panel is being closed). */
  discard: () => void;
  /** Text or files present and not locked. */
  canSend: boolean;
  locked: boolean;
}

/**
 * Draft, files and model choice of one chat panel. Sending hands the message to the question
 * store (an outbox entry until the 202) and clears the composer; if the send fails or is
 * aborted before the 202, the draft and files come back (the store asks this panel through
 * `claimOutbox`; once the panel is gone they go to the draft stash instead).
 *
 * The draft survives remounts through the in-memory draft stash. The model choice shares one
 * localStorage key, so a change in one panel reaches another panel only when it remounts.
 */
export function useComposer({ treeId, stashKey, target, locked }: ComposerOptions): ComposerState {
  const store = useQuestionStore();
  const available = useModels();
  const [initial] = useState(() => draftStash.get(stashKey));
  const [draft, setDraftState] = useState(initial?.text ?? '');
  const [files, setFilesState] = useState<ComposerFile[]>(initial?.files ?? []);
  // Latest values, updated synchronously: back-to-back adds validate against each other, and
  // the unmount cleanup writes the stash.
  const draftRef = useRef(draft);
  const filesRef = useRef<ComposerFile[]>(files);
  const setDraft = useCallback((next: string) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const setFiles = useCallback((next: ComposerFile[]) => {
    filesRef.current = next;
    setFilesState(next);
  }, []);
  const [fileErrors, setFileErrors] = useState<RejectedFile[]>([]);
  const [models, setModels] = useState<ModelChoice>(loadModels);
  const composer = useRef<ComposerHandle>(null);
  const releases = useRef(new Set<() => void>());

  const targetRef = useRef(target);
  useLayoutEffect(() => {
    targetRef.current = target;
  });

  // The draft outlives the panel (switching asides, trees or focus).
  useEffect(
    () => () => draftStash.set(stashKey, { text: draftRef.current, files: filesRef.current }),
    [stashKey],
  );
  // Sends keep going after unmount; `QuestionEffects` then takes care of their end.
  useEffect(() => {
    const claims = releases.current;
    return () => {
      for (const release of [...claims]) release();
      claims.clear();
    };
  }, []);

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

  const send = useCallback(() => {
    const text = draftRef.current.trim();
    const sent = filesRef.current;
    if (!canSendMessage(text, sent, locked)) return;
    const { parentId, context } = targetRef.current;
    // A new send replaces this target's "Not sent" entries.
    for (const entry of Object.values(store.getState().outbox)) {
      if (
        entry.error !== null &&
        entry.tree === treeId &&
        entry.parentId === parentId &&
        sameContext(entry.context, context)
      )
        store.dropOutbox(entry.id);
    }
    const id = store.ask({
      tree: treeId,
      parentId,
      context,
      stashKey,
      text,
      files: sent,
      model: choice.model ?? undefined,
      namingModel: choice.namingModel ?? undefined,
    });
    const onEnd = (end: OutboxEnd): boolean => {
      releases.current.delete(release);
      setDraft(draftRef.current || end.entry.text);
      setFiles(restoreFiles(filesRef.current, end.entry.files));
      if (end.outcome !== 'failed') return false;
      // Shown inline only while the panel still targets the same parent.
      const live = targetRef.current;
      return (
        live.parentId === end.entry.parentId &&
        sameContext(live.context, end.entry.context) &&
        end.entry.tree === treeId
      );
    };
    const release = store.claimOutbox(id, onEnd);
    releases.current.add(release);
    setDraft('');
    setFiles([]);
    setFileErrors([]);
    draftStash.set(stashKey, null);
  }, [locked, store, treeId, stashKey, choice.model, choice.namingModel, setDraft, setFiles]);

  const quote = useCallback(
    (text: string) => {
      setDraft(appendQuote(draftRef.current, text));
      composer.current?.focusEnd();
    },
    [setDraft],
  );

  const discard = useCallback(() => {
    setDraft('');
    setFiles([]);
    draftStash.set(stashKey, null);
  }, [setDraft, setFiles, stashKey]);

  return {
    draft,
    setDraft,
    composer,
    models: choice,
    changeModels,
    send,
    quote,
    appendToDraft: quote,
    files,
    fileErrors,
    addFiles,
    removeFile,
    dismissFileErrors,
    discard,
    canSend: canSendMessage(draft, files, locked),
    locked,
  };
}
