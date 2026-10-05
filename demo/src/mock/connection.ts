/**
 * The question "event stream" of the demo: a `QuestionConnection` (see
 * `web/src/api/question-events.ts`) fed straight from the mock registry. Like the real one,
 * every (re)connection starts with a full snapshot.
 */
import type {
  QuestionConnection,
  QuestionConnectionHandlers,
} from '../../../web/src/api/question-events';
import type { Questions } from './questions';

export function demoConnection(
  questions: Questions,
): (handlers: QuestionConnectionHandlers) => QuestionConnection {
  return ({ onEvent, onStatus }) => {
    let unsubscribe: (() => void) | null = null;
    const connect = () => {
      onStatus('connecting');
      unsubscribe = questions.subscribe(onEvent);
      onEvent({ event: 'snapshot', data: questions.snapshot() });
      onStatus('live');
    };
    const disconnect = () => {
      unsubscribe?.();
      unsubscribe = null;
    };
    return {
      start() {
        if (!unsubscribe) connect();
      },
      stop() {
        disconnect();
        onStatus('paused');
      },
      resync() {
        disconnect();
        connect();
      },
    };
  };
}
