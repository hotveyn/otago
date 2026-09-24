import type { ReactNode } from 'react';
import { AttachmentList } from './AttachmentList';
import { AttachmentScope, type AttachmentScopeValue } from './attachment-scope';
import { Markdown } from './Markdown';

interface ExchangeProps {
  question: string;
  answer: string;
  /** What `attachments/<name>` references and the attachment list resolve against. */
  attachments: AttachmentScopeValue;
  meta?: ReactNode;
  current?: boolean;
  streaming?: boolean;
  footer?: ReactNode;
}

export function Exchange({
  question,
  answer,
  attachments,
  meta,
  current,
  streaming,
  footer,
}: ExchangeProps) {
  return (
    <article className={current ? 'exchange exchange-current' : 'exchange'}>
      {meta && <div className="exchange-meta">{meta}</div>}
      <div className="msg msg-user">
        <Markdown text={question} plain />
      </div>
      <div className="msg msg-assistant">
        <AttachmentScope.Provider value={attachments}>
          {answer ? (
            <Markdown text={answer} streaming={streaming} />
          ) : streaming ? null : (
            <p className="muted">No answer.</p>
          )}
          <AttachmentList />
        </AttachmentScope.Provider>
        {streaming && <span className="caret" aria-hidden />}
      </div>
      {footer}
    </article>
  );
}
