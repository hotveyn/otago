import { ApiError } from '../api/client';
import { i18n } from '../i18n';

export type ErrorKind = 'busy-structural' | 'busy-streaming' | 'node-missing' | 'other';

export interface DescribedError {
  message: string;
  kind: ErrorKind;
}

export const nodeMissingMessage = (): string => i18n.t('errors.nodeMissing');

const plainMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** User-facing text for an API failure, with a kind for callers that react to it. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'tree_busy_structural')
      return {
        kind: 'busy-structural',
        message: i18n.t('errors.busyStructural'),
      };
    if (error.status === 409 && error.code === 'tree_busy_streaming')
      return {
        kind: 'busy-streaming',
        message: i18n.t('errors.busyStreaming'),
      };
    if (error.status === 404 && error.message.startsWith('Node not found:'))
      return { kind: 'node-missing', message: error.message };
  }
  return { kind: 'other', message: plainMessage(error) };
}

export const isNodeMissing = (error: unknown): boolean =>
  describeError(error).kind === 'node-missing';
