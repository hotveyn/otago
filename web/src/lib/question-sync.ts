/**
 * Glue between the question event stream and the store, plus the connection policy:
 *  - hidden tab for `hiddenDisconnectMs` → disconnect (the HTTP/1.1 pool is shared by all
 *    tabs); visible again → reconnect (lossless: the snapshot carries the full state);
 *  - `online` → reconnect at once when not live;
 *  - every 5 s while live → expire 202 copies the stream never confirmed.
 * Extension seams: `hiddenDisconnectMs: null` keeps hidden tabs connected (future completion
 * notifications); `connect` is injectable (a future leader tab / BroadcastChannel follower).
 */
import {
  createQuestionConnection,
  type QuestionConnection,
  type QuestionConnectionHandlers,
} from '../api/question-events';
import type { QuestionStore } from './question-store';

export const UNCONFIRMED_CHECK_MS = 5_000;

type EventTargetLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface QuestionSyncOptions {
  connect?: (handlers: QuestionConnectionHandlers) => QuestionConnection;
  /** `null`: stay connected while hidden. */
  hiddenDisconnectMs?: number | null;
  unconfirmedGraceMs?: number;
  doc?: EventTargetLike & { readonly hidden: boolean };
  win?: EventTargetLike;
  now?: () => number;
}

/** Start syncing; returns `stop`. Call once per tab, outside React. */
export function startQuestionSync(
  store: QuestionStore,
  {
    connect = createQuestionConnection,
    hiddenDisconnectMs = 30_000,
    unconfirmedGraceMs = 10_000,
    doc = document,
    win = window,
    now = Date.now,
  }: QuestionSyncOptions = {},
): () => void {
  let connection: QuestionConnection | null = null;
  connection = connect({
    onEvent: (event) => {
      const { resync } = store.receive(event);
      if (resync) connection?.resync();
    },
    onStatus: (status) => store.setConnection(status),
  });
  const conn = connection;

  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  const clearHiddenTimer = () => {
    if (hiddenTimer !== null) clearTimeout(hiddenTimer);
    hiddenTimer = null;
  };
  const onVisibility = () => {
    if (doc.hidden) {
      if (hiddenDisconnectMs === null || hiddenTimer !== null) return;
      hiddenTimer = setTimeout(() => {
        hiddenTimer = null;
        conn.stop();
      }, hiddenDisconnectMs);
      return;
    }
    clearHiddenTimer();
    if (store.getState().connection === 'paused') conn.start();
  };
  const onOnline = () => {
    const status = store.getState().connection;
    if (status !== 'live' && status !== 'paused') conn.resync();
  };
  const expiry = setInterval(() => {
    if (store.getState().connection === 'live') store.expireUnconfirmed(now(), unconfirmedGraceMs);
  }, UNCONFIRMED_CHECK_MS);

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('online', onOnline);
  conn.start();
  if (doc.hidden) onVisibility();

  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('online', onOnline);
    clearHiddenTimer();
    clearInterval(expiry);
    conn.stop();
  };
}
