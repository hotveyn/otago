import { useMutation } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { QuestionContext } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { pushNotice } from '../../lib/notices';
import {
  useHydrated,
  useOutboxFor,
  useQuestionStore,
  useQuestionView,
} from '../../lib/question-store';
import { type InFlightView, inFlightCanCancel, inFlightStatus } from '../../lib/questions';
import type { InFlightActions } from './InFlightExchange';

export interface InFlightOptions {
  treeId: string;
  context: QuestionContext;
  /** The panel's parent node (where its next message goes). */
  parentId: string;
  /** Focused question id from the URL (`q` / `sideQ`), if any. */
  focus: string | null;
}

export interface InFlight {
  /** What the panel shows after its thread: the focused question, else its newest send. */
  view: InFlightView | null;
  /** Nothing can be sent (a "Not sent" entry keeps the composer usable to resend). */
  locked: boolean;
  /** Present only when the view can be cancelled now. */
  cancel?: () => void;
  actions: InFlightActions;
}

/** The in-flight exchange of one chat panel and its actions. */
export function useInFlight({ treeId, context, parentId, focus }: InFlightOptions): InFlight {
  const store = useQuestionStore();
  const hydrated = useHydrated();
  const question = useQuestionView(focus);
  const outbox = useOutboxFor(treeId, context, focus === null ? parentId : null);

  const view = useMemo<InFlightView | null>(() => {
    if (focus !== null) {
      if (question) {
        // Saved and its node is in the tree: the URL is about to follow it.
        if (question.info.status === 'done' && question.acked) return null;
        return {
          kind: 'question',
          info: question.info,
          stream: question.stream,
          localFiles: question.localFiles,
          cancelling: question.cancelling,
        };
      }
      return hydrated ? null : { kind: 'loading', id: focus };
    }
    return outbox ? { kind: 'outbox', entry: outbox } : null;
  }, [focus, question, hydrated, outbox]);

  const retry = useMutation({ mutationFn: (id: string) => store.retry(id) });
  const dismiss = useMutation({ mutationFn: (id: string) => store.dismiss(id) });

  const cancelView = useCallback(() => {
    if (!view) return;
    if (view.kind === 'outbox') store.abortOutbox(view.entry.id);
    else if (view.kind === 'question')
      store
        .cancel(view.info.id)
        .catch((error: unknown) =>
          pushNotice({ kind: 'error', message: describeError(error).message }),
        );
  }, [store, view]);

  const questionId = view?.kind === 'question' ? view.info.id : null;
  const outboxId = view?.kind === 'outbox' ? view.entry.id : null;
  const actions: InFlightActions = {
    retry: questionId === null ? undefined : () => retry.mutate(questionId),
    retrying: retry.isPending,
    retryError: retry.variables === questionId ? retry.error : null,
    dismiss: questionId === null ? undefined : () => dismiss.mutate(questionId),
    dismissing: dismiss.isPending,
    dismissError: dismiss.variables === questionId ? dismiss.error : null,
    dismissOutbox: outboxId === null ? undefined : () => store.dropOutbox(outboxId),
  };

  return {
    view,
    locked: view !== null && inFlightStatus(view) !== 'not-sent',
    cancel: view && inFlightCanCancel(view) ? cancelView : undefined,
    actions,
  };
}
