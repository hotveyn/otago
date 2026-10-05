import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { dismissNotice, type Notice, useNotices } from '../../lib/notices';

/** How long a notice stays on screen. */
const NOTICE_MS = 8_000;

function NoticeRow({ notice }: { notice: Notice }) {
  const { t } = useTranslation();
  useEffect(() => {
    const timer = setTimeout(() => dismissNotice(notice.id), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice.id]);
  return (
    <div className={notice.kind === 'error' ? 'notice notice-error' : 'notice'}>
      <span dir="auto">{notice.message}</span>
      <button
        type="button"
        className="icon-btn"
        aria-label={t('dismiss')}
        onClick={() => dismissNotice(notice.id)}
      >
        ×
      </button>
    </div>
  );
}

/** Transient notices (bottom-right of the graph pane), announced politely. */
export function Notices() {
  const notices = useNotices();
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} />
      ))}
    </div>
  );
}
