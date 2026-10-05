import { ApiError } from '../api/client';
import type { QuestionError } from '../api/types';
import { i18n } from '../i18n';
import { treeBusyDetailsOf } from './blockers';

export type ErrorKind = 'busy-structural' | 'busy-streaming' | 'node-missing' | 'other';

export interface DescribedError {
  message: string;
  kind: ErrorKind;
}

export const nodeMissingMessage = (): string => i18n.t('errors.nodeMissing');

const plainMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function busyStreamingMessage(error: ApiError): string {
  const details = treeBusyDetailsOf(error);
  const count = details ? details.questions.length + details.preparing : 0;
  return count > 0
    ? i18n.t('errors.busyStreamingCount', { count })
    : i18n.t('errors.busyStreaming');
}

/** User-facing text for an API failure, with a kind for callers that react to it. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'tree_busy_structural')
      return {
        kind: 'busy-structural',
        message: i18n.t('errors.busyStructural'),
      };
    if (error.status === 409 && error.code === 'tree_busy_streaming')
      return { kind: 'busy-streaming', message: busyStreamingMessage(error) };
    if (
      error.status === 404 &&
      (error.code === 'node_not_found' || error.message.startsWith('Node not found:'))
    )
      return { kind: 'node-missing', message: error.message };
    // A send or retry under a node that was deleted or moved meanwhile.
    if (error.status === 404 && error.code === 'parent_not_found')
      return { kind: 'node-missing', message: i18n.t('errors.parentMissing') };
    if (error.status === 404 && error.code === 'question_not_found')
      return { kind: 'other', message: i18n.t('errors.questionNotFound') };
    if (error.status === 409 && error.code === 'question_finished')
      return { kind: 'other', message: i18n.t('errors.questionFinished') };
  }
  return { kind: 'other', message: plainMessage(error) };
}

export const isNodeMissing = (error: unknown): boolean =>
  describeError(error).kind === 'node-missing';

/** Localized text of a failed attempt (`QuestionInfo.error` of a failed question). */
export function describeQuestionFailure(error: QuestionError): string {
  const values = { message: error.message };
  switch (error.code) {
    case 'agent_error':
      return i18n.t('chat:failure.agent_error', values);
    case 'timeout':
      return i18n.t('chat:failure.timeout', values);
    case 'internal':
      return i18n.t('chat:failure.internal', values);
    default:
      return error.message;
  }
}
