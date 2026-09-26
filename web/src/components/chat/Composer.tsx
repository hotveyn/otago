import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useModels } from '../../api/queries';
import {
  CHAT_FILE_ACCEPT,
  type ComposerFile,
  MAX_MESSAGE_FILES,
  pastedFilesToAdd,
  type RejectedFile,
} from '../../lib/chat-files';
import { Button } from '../ui/Button';
import { ComposerFiles } from './ComposerFiles';

export interface ModelChoice {
  model: string | null;
  namingModel: string | null;
}

export interface ComposerHandle {
  /** Focus the textarea with the caret at the end once the next value is committed. */
  focusEnd: () => void;
}

interface ComposerProps {
  ref?: Ref<ComposerHandle>;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  target: string;
  models: ModelChoice;
  onModelsChange: (models: ModelChoice) => void;
  /** Files waiting for the next send. */
  files: ComposerFile[];
  fileErrors: RejectedFile[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (id: number) => void;
  onDismissFileErrors: () => void;
  /** Text or files present and nothing streaming. */
  canSend: boolean;
}

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

export function Composer({
  ref,
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  target,
  models,
  onModelsChange,
  files,
  fileErrors,
  onAddFiles,
  onRemoveFile,
  onDismissFileErrors,
  canSend,
}: ComposerProps) {
  const { t } = useTranslation('chat');
  const available = useModels();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const wantEnd = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();
  const full = files.length >= MAX_MESSAGE_FILES;

  useImperativeHandle(
    ref,
    () => ({
      focusEnd: () => {
        wantEnd.current = true;
      },
    }),
    [],
  );

  // Runs after the new value is committed; a disabled (streaming) textarea waits for the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check whenever the text changes
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!wantEnd.current || streaming || !element) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    element.scrollTop = element.scrollHeight;
    wantEnd.current = false;
  }, [value, streaming]);

  // Grow with the content up to the CSS max-height.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (!streaming) textarea.current?.focus();
  }, [streaming]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const { files: pasted, blockText } = pastedFilesToAdd(event.clipboardData);
    if (pasted.length === 0) return;
    if (blockText) event.preventDefault();
    onAddFiles(pasted);
  };

  const onDragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = streaming ? 'none' : 'copy';
  };
  const onDrop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    // No queuing: files dropped while an answer streams are ignored.
    if (!streaming) onAddFiles(Array.from(event.dataTransfer.files));
  };

  const defaults = available.data?.defaults;
  const options = available.data?.models ?? [];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drop zone; the Attach button is the keyboard path
    <div
      className={dragging ? 'composer composer-drop' : 'composer'}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="composer-target muted small">
        {target ? (
          <Trans
            t={t}
            i18nKey="composer.replyUnder"
            values={{ target }}
            components={{ code: <code /> }}
          />
        ) : (
          t('composer.newBranch')
        )}
      </div>
      <ComposerFiles
        files={files}
        errors={fileErrors}
        onRemove={onRemoveFile}
        onDismissErrors={onDismissFileErrors}
        fallbackFocus={textarea}
        disabled={streaming}
      />
      <textarea
        ref={textarea}
        className="composer-input"
        placeholder={streaming ? t('composer.waiting') : t('composer.placeholder')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        disabled={streaming}
        rows={2}
        aria-describedby={hintId}
      />
      <span id={hintId} className="visually-hidden">
        {t('composer.dropHint')}
      </span>
      <div className="composer-bar">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('composer.attachFiles')}
          title={
            full ? t('composer.attachLimit', { max: MAX_MESSAGE_FILES }) : t('composer.attachFiles')
          }
          disabled={streaming || full}
          onClick={() => picker.current?.click()}
        >
          {t('composer.attach')}
        </Button>
        <input
          ref={picker}
          type="file"
          multiple
          accept={CHAT_FILE_ACCEPT}
          hidden
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            // Reset so picking the same file again fires `change`.
            event.target.value = '';
            onAddFiles(picked);
          }}
        />
        <label className="model-pick">
          <span>{t('composer.answerModel')}</span>
          <select
            value={models.model ?? ''}
            onChange={(event) => onModelsChange({ ...models, model: event.target.value || null })}
            disabled={streaming || options.length === 0}
          >
            <option value="">
              {defaults
                ? t('composer.defaultModel', { model: defaults.answer })
                : t('composer.default')}
            </option>
            {options.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="model-pick">
          <span>{t('composer.namingModel')}</span>
          <select
            value={models.namingModel ?? ''}
            onChange={(event) =>
              onModelsChange({ ...models, namingModel: event.target.value || null })
            }
            disabled={streaming || options.length === 0}
          >
            <option value="">
              {defaults
                ? t('composer.defaultModel', { model: defaults.naming })
                : t('composer.default')}
            </option>
            {options.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        {streaming ? (
          <Button variant="default" onClick={onStop}>
            {t('composer.stop')}
          </Button>
        ) : (
          <Button variant="primary" onClick={onSend} disabled={!canSend}>
            {t('composer.send')}
          </Button>
        )}
      </div>
    </div>
  );
}
