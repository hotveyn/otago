import { useTranslation } from 'react-i18next';

interface ErrorNoteProps {
  error: unknown;
  onDismiss?: () => void;
  /** Shown instead of the error's own message. */
  message?: string;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ErrorNote({ error, onDismiss, message }: ErrorNoteProps) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      <span>{message ?? errorMessage(error)}</span>
      {onDismiss && (
        <button type="button" className="icon-btn" aria-label={t('dismiss')} onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
