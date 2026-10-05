import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { keys, seedDoneChain } from '../api/queries';
import { i18n } from '../i18n';
import { describeError } from '../lib/chat-errors';
import { draftStash, mergeDraft } from '../lib/draft-stash';
import { pushNotice } from '../lib/notices';
import { acceptedFocus, focusedIn, reconcileFocus } from '../lib/question-focus';
import { useQuestionStore, useStoreSelector } from '../lib/question-store';
import {
  isRunning,
  type LifecycleEvent,
  pendingLabel,
  questionTitle,
  type RemovedReason,
} from '../lib/questions';
import { type Navigate, readUrlState, type UrlState } from '../lib/url-state';

interface QuestionEffectsProps {
  url: UrlState;
  navigate: Navigate;
}

const patchEqual = (a: Partial<UrlState> | null, b: Partial<UrlState> | null) =>
  JSON.stringify(a) === JSON.stringify(b);

function removedMessage(reason: RemovedReason, title: string): string | null {
  switch (reason) {
    case 'cancelled':
      return i18n.t('notices.cancelledElsewhere', { title });
    case 'dismissed':
      return i18n.t('notices.dismissedElsewhere', { title });
    case 'expired':
    case 'evicted':
      return i18n.t('notices.expired', { title });
    case 'deleted':
      return i18n.t('notices.parentDeleted', { title });
    case 'missing':
      return i18n.t('notices.vanished', { title });
    default:
      return null;
  }
}

/**
 * App-level side effects of question lifecycle events (rendered once, returns nothing):
 * focus a just-accepted question, refresh the tree and follow a saved one, report removals
 * of the focused question, bring back drafts of failed sends. Async handlers always read the
 * LIVE URL: completions race with navigation.
 */
export function QuestionEffects({ url, navigate }: QuestionEffectsProps) {
  const store = useQuestionStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    let lostOnRestart = 0;
    let restartFlush = false;
    const live = () => readUrlState(window.location.search);

    const onDone = (event: Extract<LifecycleEvent, { type: 'done' }>) => {
      const question = event.question;
      if (focusedIn(live(), question.id) !== null) {
        const text = store.getState().streams[question.id]?.text;
        if (text !== undefined) seedDoneChain(queryClient, question, text);
      }
      void queryClient
        .invalidateQueries({ queryKey: keys.tree(question.tree) })
        .catch(() => undefined)
        .then(() => {
          const state = store.getState();
          if (state.questions[question.id]?.status !== 'done') return;
          // Follow before the ack publishes, so the panel never shows an empty exchange.
          const patch = reconcileFocus(live(), {
            ...state,
            acked: { ...state.acked, [question.id]: true },
          });
          if (patch) navigate(patch, true);
          store.ack(question.id);
        });
    };

    const onRemoved = (event: Extract<LifecycleEvent, { type: 'removed' }>) => {
      if (event.local) return;
      const question = event.question;
      if (event.reason === 'restart') {
        if (question && isRunning(question)) lostOnRestart += 1;
        else if (question && focusedIn(live(), question.id) !== null)
          pushNotice({
            kind: 'info',
            message: i18n.t('notices.vanished', { title: pendingLabel(question.title) }),
          });
        if (restartFlush) return;
        restartFlush = true;
        // One notice for every entry the restart dropped (they arrive in one snapshot).
        queueMicrotask(() => {
          restartFlush = false;
          const count = lostOnRestart;
          lostOnRestart = 0;
          if (count > 0)
            pushNotice({
              kind: 'info',
              message: i18n.t('notices.serverRestarted', { count }),
              key: 'server-restarted',
            });
        });
        return;
      }
      if (!question || focusedIn(live(), question.id) === null) return;
      const message = removedMessage(event.reason, pendingLabel(question.title));
      if (message) pushNotice({ kind: 'info', message, key: `removed:${event.id}` });
    };

    const onOutboxEnded = (event: Extract<LifecycleEvent, { type: 'outbox-ended' }>) => {
      if (event.shown) return;
      const { entry } = event;
      if (!event.restored)
        draftStash.set(
          entry.stashKey,
          mergeDraft(draftStash.get(entry.stashKey), { text: entry.text, files: entry.files }),
        );
      if (event.outcome !== 'failed') return;
      const title = pendingLabel(
        questionTitle(
          entry.text,
          entry.files.map((item) => item.file.name),
        ),
      );
      pushNotice({
        kind: 'error',
        message: i18n.t('notices.notSent', { title, message: describeError(event.error).message }),
        key: `not-sent:${entry.id}`,
      });
    };

    return store.onLifecycle((event) => {
      switch (event.type) {
        case 'accepted': {
          // Removed before its 202 arrived (e.g. cancelled elsewhere): nothing to focus.
          if (!store.getState().questions[event.question.id]) return;
          const patch = acceptedFocus(live(), event.question);
          if (!patch) return;
          // Publish first: the URL reconcile reads the published state and must already
          // know the new id, or it would drop the focus again.
          store.flush();
          navigate(patch);
          return;
        }
        case 'done':
          onDone(event);
          return;
        case 'removed':
          onRemoved(event);
          return;
        case 'outbox-ended':
          onOutboxEnded(event);
          return;
        default:
          return;
      }
    });
  }, [store, queryClient, navigate]);

  // The URL follows the store: unknown/removed focus dropped, saved focus followed to its
  // node, remapped parents followed. Replaces the history entry.
  const patch = useStoreSelector((state) => reconcileFocus(url, state), patchEqual, [url]);
  useEffect(() => {
    if (patch) navigate(patch, true);
  }, [patch, navigate]);

  return null;
}
