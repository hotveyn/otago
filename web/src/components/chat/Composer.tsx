import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { useModels } from '../../api/queries';
import { Button } from '../ui/Button';

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
}

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
}: ComposerProps) {
  const available = useModels();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const wantEnd = useRef(false);

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
      if (!streaming && value.trim()) onSend();
    }
  };

  const defaults = available.data?.defaults;
  const options = available.data?.models ?? [];

  return (
    <div className="composer">
      <div className="composer-target muted small">
        {target ? (
          <>
            Reply under <code>{target}</code>
          </>
        ) : (
          'New top-level branch'
        )}
      </div>
      <textarea
        ref={textarea}
        className="composer-input"
        placeholder={
          streaming
            ? 'Waiting for the answer…'
            : 'Ask a question. Enter to send, Shift+Enter for a new line.'
        }
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={streaming}
        rows={2}
      />
      <div className="composer-bar">
        <label className="model-pick">
          <span>Answer</span>
          <select
            value={models.model ?? ''}
            onChange={(event) => onModelsChange({ ...models, model: event.target.value || null })}
            disabled={streaming || options.length === 0}
          >
            <option value="">{defaults ? `default · ${defaults.answer}` : 'default'}</option>
            {options.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="model-pick">
          <span>Naming</span>
          <select
            value={models.namingModel ?? ''}
            onChange={(event) =>
              onModelsChange({ ...models, namingModel: event.target.value || null })
            }
            disabled={streaming || options.length === 0}
          >
            <option value="">{defaults ? `default · ${defaults.naming}` : 'default'}</option>
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
            Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={onSend} disabled={!value.trim()}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
