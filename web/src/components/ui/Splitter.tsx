import { type KeyboardEvent, type PointerEvent, useRef } from 'react';

interface SplitterProps {
  /** Width of the pane to the right of the splitter, in px. */
  value: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onReset: () => void;
  onDragChange: (dragging: boolean) => void;
}

const KEY_STEP = 32;

/** Vertical drag handle that resizes the pane on its right. */
export function Splitter({ value, min, max, onChange, onReset, onDragChange }: SplitterProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: value };
    onDragChange(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // Moving left widens the right-hand pane.
    onChange(drag.current.startWidth + drag.current.startX - event.clientX);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onDragChange(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    if (event.key === 'ArrowLeft') onChange(value + step);
    else if (event.key === 'ArrowRight') onChange(value - step);
    else if (event.key === 'Home') onChange(max);
    else if (event.key === 'End') onChange(min);
    else if (event.key === 'Enter') onReset();
    else return;
    event.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> can't be focused or dragged
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
