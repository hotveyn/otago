interface ErrorNoteProps {
  error: unknown;
  onDismiss?: () => void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ErrorNote({ error, onDismiss }: ErrorNoteProps) {
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      <span>{errorMessage(error)}</span>
      {onDismiss && (
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
