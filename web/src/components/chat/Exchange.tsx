import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AttachmentList } from './AttachmentList';
import { AttachmentScope, type AttachmentScopeValue } from './attachment-scope';
import { Markdown } from './Markdown';

interface ExchangeProps {
  question: string;
  answer: string;
  /** What `attachments/<name>` references and the attachment list resolve against. */
  attachments: AttachmentScopeValue;
  meta?: ReactNode;
  /** Files the user attached, shown under the question (outside the attachment scope). */
  files?: ReactNode;
  current?: boolean;
  streaming?: boolean;
  footer?: ReactNode;
}

export function Exchange({
  question,
  answer,
  attachments,
  meta,
  files,
  current,
  streaming,
  footer,
}: ExchangeProps) {
  const { t } = useTranslation('chat');
  return (
    <article className={current ? 'exchange exchange-current' : 'exchange'}>
      {meta && <div className="exchange-meta">{meta}</div>}
      <div className="msg msg-user">
        {question !== '' && <Markdown text={question} plain />}
        {files}
      </div>
      <div className="msg msg-assistant">
        <AttachmentScope.Provider value={attachments}>
          {answer ? (
            <Markdown text={answer} streaming={streaming} />
          ) : streaming ? null : (
            <p className="muted">{t('noAnswer')}</p>
          )}
          <AttachmentList />
        </AttachmentScope.Provider>
        {streaming && <span className="caret" aria-hidden />}
      </div>
      {footer}
    </article>
  );
}
