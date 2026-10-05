import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { TrashId } from '../../api/types';
import { i18n } from '../../i18n';
import { treeBusyDetailsOf } from '../../lib/blockers';
import { shouldHandleTreeUndo } from '../../lib/keyboard';
import { safeSession } from '../../lib/storage';
import {
  type AppliedStep,
  type HistoryEntry,
  type IdMap,
  loadHistory,
  recordDelete,
  recordMove,
  remapHistory,
  runUndo,
  saveHistory,
} from '../../lib/undo-history';

/** How long an undo failure stays on screen. */
const TOAST_MS = 6000;

export interface UndoToast {
  message: string;
  /** Bumps per toast so an identical message restarts the timer. */
  key: number;
}

interface UseTreeUndoOptions {
  treeId: string;
  /** Answers are running in the tree: undo is refused locally (see `onBusy`). */
  busy: boolean;
  /** A dialog is open or a forward move/delete is pending: Ctrl/⌘+Z is ignored. */
  blocked: boolean;
  /** A step succeeded in `treeId` (may differ from the current tree after a switch). */
  onApplied: (treeId: string, applied: AppliedStep) => void;
  /**
   * Undo is blocked by running answers: `error` is the server's 409 (`null` when refused
   * locally), `retry` runs the undo again. Without it the busy text is shown as a toast.
   */
  onBusy?: (error: unknown | null, retry: () => void) => void;
}

/** Per-tree undo stack in sessionStorage plus the Ctrl/⌘+Z handler. */
export function useTreeUndo({ treeId, busy, blocked, onApplied, onBusy }: UseTreeUndoOptions) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory(safeSession, treeId));
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<UndoToast | null>(null);

  const treeRef = useRef(treeId);
  const entriesRef = useRef(entries);
  const inFlight = useRef(false);
  const latest = useRef({ busy, blocked, onApplied, onBusy });
  useEffect(() => {
    latest.current = { busy, blocked, onApplied, onBusy };
  });

  // Tree switch: load that tree's stack, forget the old toast.
  useEffect(() => {
    treeRef.current = treeId;
    const loaded = loadHistory(safeSession, treeId);
    entriesRef.current = loaded;
    setEntries(loaded);
    setToast(null);
  }, [treeId]);

  /** Persist the stack of `forTree`; update the in-memory copy only if it is still shown. */
  const commit = useCallback((forTree: string, next: HistoryEntry[]) => {
    saveHistory(safeSession, forTree, next);
    if (forTree !== treeRef.current) return;
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast((current) => ({ message, key: (current?.key ?? 0) + 1 }));
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const record = useCallback(
    (update: (list: HistoryEntry[], now: string, id: string) => HistoryEntry[]) => {
      const forTree = treeRef.current;
      const next = update(entriesRef.current, new Date().toISOString(), crypto.randomUUID());
      if (next !== entriesRef.current) commit(forTree, next);
    },
    [commit],
  );

  const onRecordMove = useCallback(
    (moved: IdMap) => record((list, now, id) => recordMove(list, moved, now, id)),
    [record],
  );
  const onRecordDelete = useCallback(
    (deleted: Record<string, TrashId>) =>
      record((list, now, id) => recordDelete(list, deleted, now, id)),
    [record],
  );

  /** A rename changed ids (no entry is recorded; stored ids follow by prefix). */
  const remap = useCallback((map: IdMap) => record((list) => remapHistory(list, map)), [record]);

  // Latest `undo`, for the blockers dialog's "Undo now" (it may run after re-renders).
  const undoRef = useRef<() => Promise<void>>(async () => undefined);
  const retryUndo = useCallback(() => {
    if (!inFlight.current) void undoRef.current();
  }, []);

  const undo = useCallback(async (): Promise<void> => {
    const forTree = treeRef.current;
    const start = entriesRef.current;
    if (start.length === 0) return;
    inFlight.current = true;
    setPending(true);
    try {
      const outcome = await runUndo(
        start,
        {
          move: (ids, target, names) => api.moveNodes(forTree, ids, target, names),
          restore: (trashIds) => api.restoreNodes(forTree, trashIds),
        },
        (applied) => {
          commit(forTree, applied.entries);
          latest.current.onApplied(forTree, applied);
        },
      );
      commit(forTree, outcome.entries);
      const error = outcome.error;
      if (error && forTree === treeRef.current) {
        const handleBusy = latest.current.onBusy;
        // The entry is kept (409); the blockers dialog offers the undo again.
        if (handleBusy && treeBusyDetailsOf(error.cause)) handleBusy(error.cause, retryUndo);
        else showToast(error.message);
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [commit, showToast, retryUndo]);
  useEffect(() => {
    undoRef.current = undo;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shouldHandleTreeUndo(event)) return;
      event.preventDefault();
      if (inFlight.current) return;
      const { busy, blocked, onBusy } = latest.current;
      if (blocked) return;
      if (entriesRef.current.length === 0) return;
      if (busy) {
        if (onBusy) onBusy(null, retryUndo);
        else showToast(i18n.t('errors.busyStreaming'));
        return;
      }
      void undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, showToast, retryUndo]);

  return {
    recordMove: onRecordMove,
    recordDelete: onRecordDelete,
    remap,
    pending,
    toast,
    dismissToast,
    canUndo: entries.length > 0,
  };
}
