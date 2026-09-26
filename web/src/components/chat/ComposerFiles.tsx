import { type RefObject, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '../../lib/attachments';
import {
  type ComposerFile,
  isChatImage,
  MAX_MESSAGE_FILES,
  type RejectedFile,
} from '../../lib/chat-files';
import { KindBadge } from './AttachmentInline';
import { LocalThumb } from './LocalThumb';

interface ComposerFilesProps {
  files: ComposerFile[];
  errors: RejectedFile[];
  onRemove: (id: number) => void;
  onDismissErrors: () => void;
  /** Receives focus when the last chip is removed. */
  fallbackFocus: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}

/** Files waiting in the composer, the files it refused, and a live count for screen readers. */
export function ComposerFiles({
  files,
  errors,
  onRemove,
  onDismissErrors,
  fallbackFocus,
  disabled,
}: ComposerFilesProps) {
  const { t } = useTranslation('chat');
  const list = useRef<HTMLUListElement>(null);

  const remove = (index: number, id: number) => {
    onRemove(id);
    // Focus the chip that takes this one's place, the previous one, or the textarea.
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('.composer-file-remove');
    const next = buttons?.[index + 1] ?? buttons?.[index - 1];
    if (next) next.focus();
    else fallbackFocus.current?.focus();
  };

  return (
    <>
      {files.length > 0 && (
        <ul className="composer-files" aria-label={t('composer.attachedFiles')} ref={list}>
          {files.map((item, index) => (
            <li key={item.id} className="composer-file">
              <KindBadge name={item.file.name} />
              {isChatImage(item.file) && (
                <LocalThumb file={item.file} className="composer-file-thumb" />
              )}
              <span className="composer-file-name truncate" title={item.file.name}>
                {item.file.name}
              </span>
              <span className="attachment-size">{formatBytes(item.file.size)}</span>
              <button
                type="button"
                className="icon-btn composer-file-remove"
                aria-label={t('composer.removeFile', { name: item.file.name })}
                title={t('composer.remove')}
                disabled={disabled}
                onClick={() => remove(index, item.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <div className="composer-file-errors" role="alert">
          <ul>
            {errors.map((error, index) => (
              // Rejections have no identity; the list is replaced as a whole.
              // biome-ignore lint/suspicious/noArrayIndexKey: static list replaced on each add
              <li key={index}>
                <span className="composer-file-name">{error.name}</span>: {error.reason}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('composer.dismissFileErrors')}
            onClick={onDismissErrors}
          >
            ×
          </button>
        </div>
      )}
      <span className="visually-hidden" aria-live="polite">
        {files.length === 0
          ? ''
          : t('composer.filesAttached', { count: files.length, max: MAX_MESSAGE_FILES })}
      </span>
    </>
  );
}
