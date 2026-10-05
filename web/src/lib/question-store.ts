/**
 * The questions store: the pure reducer of `questions.ts` plus side effects (HTTP calls,
 * outbox aborts, notification batching).
 *
 * Two copies of the state:
 *  - `getState()` = CURRENT, updated by every action. For imperative code and lifecycle
 *    listeners (they run synchronously, in order, right after the action).
 *  - `getSnapshot()` = PUBLISHED, copied at most once per animation frame. React reads only
 *    this one (`useSyncExternalStore`), so a burst of chunks costs one render.
 * The graph never subscribes to stream text; only the focused panels do (`useQuestionView`).
 */
import {
  createContext,
  type DependencyList,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { isApiError } from '../api/client';
import type { QuestionContext, QuestionId, QuestionInfo, QuestionStreamEvent } from '../api/types';
import type { ComposerFile } from './chat-files';
import {
  type ConnectionStatus,
  createCachedSelector,
  initialQuestionsState,
  type LifecycleEvent,
  type OutboxEntry,
  type PendingBox,
  type PendingStatusInfo,
  pendingBoxesEqual,
  pendingStatusesEqual,
  type QuestionAction,
  type QuestionsState,
  type QuestionView,
  questionViewEqual,
  reduce,
  selectIsTreeBusy,
  selectOutboxFor,
  selectPendingBoxes,
  selectPendingStatuses,
  selectQuestionView,
  selectTreeCounts,
  type TreeCounts,
  treeCountsEqual,
} from './questions';

/** The HTTP calls the store needs (`api` from `api/client.ts` fits). */
export interface QuestionApi {
  startQuestion(
    treeId: string,
    input: {
      parentId: string;
      text: string;
      model?: string;
      namingModel?: string;
      context: QuestionContext;
      files?: readonly File[];
    },
    signal?: AbortSignal,
  ): Promise<QuestionInfo>;
  cancelQuestion(id: QuestionId): Promise<void>;
  retryQuestion(id: QuestionId): Promise<QuestionInfo>;
}

export interface AskInput {
  tree: string;
  parentId: string;
  context: QuestionContext;
  /** Where the draft goes back if the send fails after the panel is gone. */
  stashKey: string;
  /** Trimmed text (may be `""` with files). */
  text: string;
  files: ComposerFile[];
  model?: string;
  namingModel?: string;
}

/** How a send ended before its 202. */
export interface OutboxEnd {
  outcome: 'aborted' | 'failed';
  entry: OutboxEntry;
  /** `null` for an abort. */
  error: unknown;
}

/** Structural change made by this tab, mirrored locally until the server's events arrive. */
export type LocalChange =
  | { kind: 'remap'; tree: string; map: Record<string, string> }
  | { kind: 'dropUnder'; tree: string; ids: string[] }
  | { kind: 'renameTree'; from: string; to: string };

export interface QuestionStore {
  getState(): QuestionsState;
  getSnapshot(): QuestionsState;
  subscribe(listener: () => void): () => void;
  onLifecycle(listener: (event: LifecycleEvent) => void): () => void;
  /** Feed one stream event; `resync` asks the connection for a fresh snapshot (chunk gap). */
  receive(event: QuestionStreamEvent): { resync: boolean };
  setConnection(status: ConnectionStatus): void;
  /** Send a question; returns the outbox id. The outcome arrives as lifecycle events. */
  ask(input: AskInput): string;
  /**
   * The sending panel takes the draft back when the send ends before its 202. `onEnd` returns
   * whether the panel shows the failure inline. Returns the release function.
   */
  claimOutbox(outboxId: string, onEnd: (end: OutboxEnd) => boolean): () => void;
  abortOutbox(outboxId: string): void;
  dropOutbox(outboxId: string): void;
  /** DELETE a running question. Resolves once it is gone (or finished first). */
  cancel(id: QuestionId): Promise<void>;
  /** DELETE a failed question. */
  dismiss(id: QuestionId): Promise<void>;
  retry(id: QuestionId): Promise<void>;
  /** A done question's node is in the refetched tree: drop its text and box. */
  ack(id: QuestionId): void;
  applyLocal(change: LocalChange): void;
  expireUnconfirmed(now: number, graceMs: number): void;
  /** Publish now (tests, or before reading the snapshot imperatively). */
  flush(): void;
}

export type Schedule = (callback: () => void) => void;

/** rAF while visible; a short timer while hidden (rAF does not fire in background tabs). */
export const defaultSchedule: Schedule = (callback) => {
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (!hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 100);
};

export interface QuestionStoreOptions {
  api: QuestionApi;
  now?: () => number;
  schedule?: Schedule;
}

let nextOutboxId = 1;

export function createQuestionStore({
  api,
  now = Date.now,
  schedule = defaultSchedule,
}: QuestionStoreOptions): QuestionStore {
  let current = initialQuestionsState;
  let published = current;
  let scheduled = false;
  const listeners = new Set<() => void>();
  const lifecycleListeners = new Set<(event: LifecycleEvent) => void>();
  const controllers = new Map<string, AbortController>();
  const claims = new Map<string, (end: OutboxEnd) => boolean>();

  const flush = () => {
    scheduled = false;
    if (published === current) return;
    published = current;
    for (const listener of [...listeners]) listener();
  };

  const emit = (events: readonly LifecycleEvent[]) => {
    for (const event of events) {
      for (const listener of [...lifecycleListeners]) {
        try {
          listener(event);
        } catch (error) {
          console.error(error);
        }
      }
    }
  };

  const dispatch = (action: QuestionAction) => {
    const result = reduce(current, action, now());
    if (result.state !== current) {
      current = result.state;
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    }
    emit(result.lifecycle);
    return result;
  };

  const endOutbox = (outboxId: string, outcome: OutboxEnd['outcome'], error: unknown) => {
    const entry = current.outbox[outboxId];
    if (!entry) return;
    const claim = claims.get(outboxId);
    claims.delete(outboxId);
    const end: OutboxEnd = { outcome, entry, error: outcome === 'aborted' ? null : error };
    let shown = false;
    if (claim) {
      try {
        shown = claim(end);
      } catch (cause) {
        console.error(cause);
      }
    }
    if (outcome === 'failed' && shown) dispatch({ type: 'outbox/failed', outboxId, error });
    else dispatch({ type: 'outbox/drop', outboxId });
    emit([
      {
        type: 'outbox-ended',
        outcome,
        entry,
        error: end.error,
        shown: outcome === 'failed' && shown,
        restored: claim !== undefined,
        source: 'local',
      },
    ]);
  };

  /** DELETE with the shared 204/404 handling; 409 `question_finished` is not an error. */
  const remove = async (id: QuestionId, reason: 'cancelled' | 'dismissed') => {
    dispatch({ type: 'cancel/start', id });
    try {
      await api.cancelQuestion(id);
    } catch (error) {
      if (isApiError(error, 404, 'question_not_found')) {
        dispatch({ type: 'local/removed', id, reason });
        return;
      }
      dispatch({ type: 'cancel/end', id });
      // The commit won the race: its `done` event was emitted before this 409.
      if (isApiError(error, 409, 'question_finished')) return;
      throw error;
    }
    dispatch({ type: 'local/removed', id, reason });
  };

  return {
    getState: () => current,
    getSnapshot: () => published,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => lifecycleListeners.delete(listener);
    },
    receive(event) {
      return { resync: dispatch({ type: 'event', event }).resync };
    },
    setConnection(status) {
      dispatch({ type: 'connection', status });
    },
    ask(input) {
      const id = `out-${nextOutboxId++}`;
      const entry: OutboxEntry = {
        id,
        tree: input.tree,
        parentId: input.parentId,
        context: input.context,
        stashKey: input.stashKey,
        text: input.text,
        files: input.files,
        model: input.model,
        namingModel: input.namingModel,
        phase: input.files.length > 0 ? 'uploading' : 'sending',
        error: null,
        createdAt: new Date(now()).toISOString(),
      };
      const controller = new AbortController();
      controllers.set(id, controller);
      dispatch({ type: 'outbox/add', entry });
      api
        .startQuestion(
          input.tree,
          {
            parentId: input.parentId,
            text: input.text,
            model: input.model,
            namingModel: input.namingModel,
            context: input.context,
            files: input.files.map((item) => item.file),
          },
          controller.signal,
        )
        .then(
          (question) => {
            controllers.delete(id);
            claims.delete(id);
            dispatch({ type: 'outbox/accepted', outboxId: id, question });
          },
          (error: unknown) => {
            controllers.delete(id);
            endOutbox(id, controller.signal.aborted ? 'aborted' : 'failed', error);
          },
        );
      return id;
    },
    claimOutbox(outboxId, onEnd) {
      claims.set(outboxId, onEnd);
      return () => {
        if (claims.get(outboxId) === onEnd) claims.delete(outboxId);
      };
    },
    abortOutbox(outboxId) {
      controllers.get(outboxId)?.abort();
    },
    dropOutbox(outboxId) {
      controllers.get(outboxId)?.abort();
      dispatch({ type: 'outbox/drop', outboxId });
    },
    cancel: (id) => remove(id, 'cancelled'),
    dismiss: (id) => remove(id, 'dismissed'),
    async retry(id) {
      try {
        const question = await api.retryQuestion(id);
        dispatch({ type: 'http/question', question });
      } catch (error) {
        if (isApiError(error, 404, 'question_not_found')) {
          // Gone meanwhile (expired, deleted, server restarted): say so where it was shown.
          dispatch({ type: 'local/removed', id, reason: 'missing', local: false });
          return;
        }
        throw error;
      }
    },
    ack(id) {
      dispatch({ type: 'ack', id });
    },
    applyLocal(change) {
      switch (change.kind) {
        case 'remap':
          dispatch({ type: 'local/remap', tree: change.tree, map: change.map });
          return;
        case 'dropUnder':
          dispatch({ type: 'local/dropUnder', tree: change.tree, ids: change.ids });
          return;
        case 'renameTree':
          dispatch({ type: 'local/renameTree', from: change.from, to: change.to });
          return;
      }
    },
    expireUnconfirmed(at, graceMs) {
      dispatch({ type: 'expireUnconfirmed', now: at, graceMs });
    },
    flush,
  };
}

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

export const QuestionStoreContext = createContext<QuestionStore | null>(null);

export function useQuestionStore(): QuestionStore {
  const store = useContext(QuestionStoreContext);
  if (!store) throw new Error('QuestionStoreContext is missing');
  return store;
}

/**
 * Subscribe to a derived value of the PUBLISHED state. `select`/`equal` are captured per
 * `deps` (like `useMemo`); the cached getter keeps references stable while values are equal.
 */
export function useStoreSelector<T>(
  select: (state: QuestionsState) => T,
  equal: (a: T, b: T) => boolean,
  deps: DependencyList,
): T {
  const store = useQuestionStore();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `select`/`equal` change with `deps`
  const getSnapshot = useMemo(() => {
    const cached = createCachedSelector(select, equal);
    return () => cached(store.getSnapshot());
  }, [store, ...deps]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export const useQuestionView = (id: QuestionId | null): QuestionView | null =>
  useStoreSelector(
    (state) => (id === null ? null : selectQuestionView(state, id)),
    questionViewEqual,
    [id],
  );

export const useOutboxFor = (
  tree: string,
  context: QuestionContext,
  parentId: string | null,
): OutboxEntry | null =>
  useStoreSelector(
    (state) => (parentId === null ? null : selectOutboxFor(state, tree, context, parentId)),
    Object.is,
    [tree, context.kind, context.kind === 'side' ? context.anchor : null, parentId],
  );

export const useTreeBusy = (tree: string): boolean =>
  useStoreSelector((state) => selectIsTreeBusy(state, tree), Object.is, [tree]);

export const usePendingBoxes = (tree: string): PendingBox[] =>
  useStoreSelector((state) => selectPendingBoxes(state, tree), pendingBoxesEqual, [tree]);

export const usePendingStatuses = (tree: string): Record<string, PendingStatusInfo> =>
  useStoreSelector((state) => selectPendingStatuses(state, tree), pendingStatusesEqual, [tree]);

export const useTreeCounts = (): Record<string, TreeCounts> =>
  useStoreSelector(selectTreeCounts, treeCountsEqual, []);

export const useConnectionStatus = (): ConnectionStatus =>
  useStoreSelector((state) => state.connection, Object.is, []);

export const useHydrated = (): boolean =>
  useStoreSelector((state) => state.hydrated, Object.is, []);
