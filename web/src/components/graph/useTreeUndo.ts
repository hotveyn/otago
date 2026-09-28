import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { TrashId } from '../../api/types';
import { i18n } from '../../i18n';
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
  /** An answer is streaming: undo is refused locally with the busy text. */
  streaming: boolean;
  /** A dialog is open or a forward move/delete is pending: Ctrl/⌘+Z is ignored. */
  blocked: boolean;
  /** A step succeeded in `treeId` (may differ from the current tree after a switch). */
  onApplied: (treeId: string, applied: AppliedStep) => void;
}

/** Per-tree undo stack in sessionStorage plus the Ctrl/⌘+Z handler. */
export function useTreeUndo({ treeId, streaming, blocked, onApplied }: UseTreeUndoOptions) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory(safeSession, treeId));
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState<UndoToast | null>(null);

  const treeRef = useRef(treeId);
  const entriesRef = useRef(entries);
  const inFlight = useRef(false);
  const latest = useRef({ streaming, blocked, onApplied });
  useEffect(() => {
    latest.current = { streaming, blocked, onApplied };
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

  const undo = useCallback(async () => {
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
      if (outcome.error && forTree === treeRef.current) showToast(outcome.error.message);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, [commit, showToast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!shouldHandleTreeUndo(event)) return;
      event.preventDefault();
      if (inFlight.current) return;
      const { streaming, blocked } = latest.current;
      if (blocked) return;
      if (entriesRef.current.length === 0) return;
      if (streaming) {
        showToast(i18n.t('errors.busyStreaming'));
        return;
      }
      void undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, showToast]);

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
