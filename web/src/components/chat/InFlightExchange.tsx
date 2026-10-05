import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isApiError } from '../../api/client';
import { describeError, describeQuestionFailure } from '../../lib/chat-errors';
import { type InFlightStatus, type InFlightView, inFlightStatus } from '../../lib/questions';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { Exchange } from './Exchange';
import { UserFileList } from './UserFileList';

export interface InFlightActions {
  retry?: () => void;
  retrying?: boolean;
  retryError?: unknown;
  dismiss?: () => void;
  dismissing?: boolean;
  dismissError?: unknown;
  /** Drop a "Not sent" send. */
  dismissOutbox?: () => void;
}

interface InFlightExchangeProps {
  treeId: string;
  view: InFlightView;
  actions?: InFlightActions;
  /** Extra content under a "Not sent" failure (e.g. the side chat's close button). */
  footer?: (error: unknown) => ReactNode;
}

function useStatusLabel(status: InFlightStatus): string {
  const { t } = useTranslation('chat');
  switch (status) {
    case 'sending':
      return t('inFlight.sending');
    case 'uploading':
      return t('inFlight.uploading');
    case 'answering':
      return t('inFlight.answering');
    case 'saving':
      return t('inFlight.saving');
    case 'cancelling':
      return t('inFlight.cancelling');
    case 'failed':
      return t('inFlight.failed');
    case 'not-sent':
      return t('inFlight.notSent');
    default:
      return t('inFlight.loading');
  }
}

function filesOf(view: InFlightView, status: InFlightStatus): ReactNode {
  if (view.kind === 'outbox') {
    const { files } = view.entry;
    if (files.length === 0) return undefined;
    return (
      <UserFileList pending={files} status={status === 'not-sent' ? 'notSaved' : 'uploading'} />
    );
  }
  if (view.kind !== 'question') return undefined;
  const fileStatus = view.info.status === 'failed' ? 'keptForRetry' : 'attached';
  if (view.localFiles && view.localFiles.length > 0)
    return <UserFileList pending={view.localFiles} status={fileStatus} />;
  if (view.info.files.length > 0)
    return <UserFileList staged={view.info.files} status={fileStatus} />;
  return undefined;
}

/**
 * The exchange a chat panel shows while its question is in flight: a send before its 202, a
 * streaming/saving answer, a failed answer (Retry/Dismiss) or a send that was not accepted.
 */
export function InFlightExchange({ treeId, view, actions = {}, footer }: InFlightExchangeProps) {
  const { t } = useTranslation('chat');
  const status = inFlightStatus(view);
  const label = useStatusLabel(status);
  const stream = view.kind === 'question' ? view.stream : null;
  const question =
    view.kind === 'outbox' ? view.entry.text : view.kind === 'question' ? view.info.text : '';
  const model =
    view.kind === 'outbox' ? view.entry.model : view.kind === 'question' ? view.info.model : '';
  const busy = Boolean(actions.retrying || actions.dismissing);

  let footerContent: ReactNode = null;
  if (view.kind === 'question' && view.info.status === 'failed' && status === 'failed') {
    const { retryError, dismissError } = actions;
    footerContent = (
      <>
        <ErrorNote error={view.info.error} message={describeQuestionFailure(view.info.error)} />
        <div className="inflight-actions">
          <Button
            size="sm"
            variant="primary"
            disabled={!actions.retry || busy}
            onClick={actions.retry}
          >
            {actions.retrying ? t('inFlight.retrying') : t('inFlight.retry')}
          </Button>
          <Button size="sm" disabled={!actions.dismiss || busy} onClick={actions.dismiss}>
            {t('inFlight.dismiss')}
          </Button>
        </div>
        {retryError ? (
          <ErrorNote
            error={retryError}
            message={
              isApiError(retryError, 404, 'parent_not_found')
                ? t('retryParentMissing')
                : describeError(retryError).message
            }
          />
        ) : null}
        {dismissError ? (
          <ErrorNote error={dismissError} message={describeError(dismissError).message} />
        ) : null}
      </>
    );
  } else if (view.kind === 'outbox' && view.entry.error !== null) {
    const { error } = view.entry;
    footerContent = (
      <>
        <ErrorNote
          error={error}
          message={describeError(error).message}
          onDismiss={actions.dismissOutbox}
        />
        {footer?.(error)}
      </>
    );
  }

  return (
    <Exchange
      question={question}
      answer={stream?.text ?? ''}
      attachments={{
        treeId,
        nodeId: null,
        attachments: [],
        streaming: stream?.attachments ?? [],
        unsaved: status === 'failed' || status === 'not-sent',
      }}
      streaming={status === 'answering'}
      emptyAnswer={null}
      files={filesOf(view, status)}
      meta={
        <>
          <span
            className={status === 'failed' || status === 'not-sent' ? 'inflight-failed' : 'muted'}
          >
            {label}
          </span>
          {model ? <span className="model-tag">{model}</span> : null}
        </>
      }
      footer={footerContent}
    />
  );
}
