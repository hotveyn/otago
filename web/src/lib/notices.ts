/** Transient notices (e.g. "cancelled in another tab"): pure list ops + a tiny module store. */
import { useSyncExternalStore } from 'react';

export interface Notice {
  id: number;
  kind: 'info' | 'error';
  message: string;
  /** Notices with the same key replace each other. */
  key?: string;
}

export const NOTICE_CAP = 3;

/** Append `notice` (newest last), replacing one with the same key; keep the newest `cap`. */
export function addNotice(list: readonly Notice[], notice: Notice, cap = NOTICE_CAP): Notice[] {
  const rest =
    notice.key === undefined ? [...list] : list.filter((item) => item.key !== notice.key);
  const next = [...rest, notice];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function removeNotice(list: readonly Notice[], id: number): Notice[] {
  return list.filter((item) => item.id !== id);
}

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const update = (next: Notice[]) => {
  notices = next;
  for (const listener of [...listeners]) listener();
};

export function pushNotice(notice: Omit<Notice, 'id'>): number {
  const id = nextId++;
  update(addNotice(notices, { ...notice, id }));
  return id;
}

export function dismissNotice(id: number): void {
  const next = removeNotice(notices, id);
  if (next.length !== notices.length) update(next);
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getNotices = (): Notice[] => notices;

export const useNotices = (): Notice[] => useSyncExternalStore(subscribeNotices, getNotices);
