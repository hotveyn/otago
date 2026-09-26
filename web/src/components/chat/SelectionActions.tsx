import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { type Box, placePopup } from '../../lib/popup-position';
import { isQuotable } from '../../lib/quote';

export interface SelectionAction {
  id: string;
  label: string;
  /** Receives the selection's visible text (Selection.toString()). */
  run: (text: string) => void;
}

interface SelectionActionsProps {
  /** Only selections fully inside this element open the popup. */
  container: RefObject<HTMLElement | null>;
  actions: SelectionAction[];
  /** Changing this value hides the popup (e.g. currentId on node switch). */
  resetKey?: unknown;
}

interface Shown {
  text: string;
  anchor: Box;
  bounds: Box;
}

/** Size used before the popup has been measured. */
const FALLBACK_SIZE = { width: 64, height: 24 };
const DEBOUNCE_MS = 120;

function toBox(rect: DOMRect): Box {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/** The visible, quotable selection fully inside `container`, or null. */
function readSelection(container: HTMLElement | null): Shown | null {
  const selection = document.getSelection();
  if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode))
    return null;
  const text = selection.toString();
  if (!isQuotable(text)) return null;

  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  const bounds = container.getBoundingClientRect();
  // The selection end is scrolled out of view.
  if (rect.bottom < bounds.top || rect.top > bounds.bottom) return null;
  return { text, anchor: toBox(rect), bounds: toBox(bounds) };
}

/** A floating toolbar over a text selection inside `container`. */
export function SelectionActions({ container, actions, resetKey }: SelectionActionsProps) {
  const { t } = useTranslation('chat');
  const [shown, setShown] = useState<Shown | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const popup = useRef<HTMLDivElement>(null);
  const pointerDown = useRef(false);
  const timer = useRef<{ frame: number; timeout: number } | null>(null);

  const cancel = useCallback(() => {
    if (!timer.current) return;
    cancelAnimationFrame(timer.current.frame);
    clearTimeout(timer.current.timeout);
    timer.current = null;
  }, []);

  const hide = useCallback(() => {
    cancel();
    setShown(null);
  }, [cancel]);

  const evaluate = useCallback(() => {
    setShown(readSelection(container.current));
  }, [container]);

  const schedule = useCallback(() => {
    cancel();
    const frame = requestAnimationFrame(() => {
      const timeout = window.setTimeout(() => {
        timer.current = null;
        if (!pointerDown.current) evaluate();
      }, DEBOUNCE_MS);
      if (timer.current) timer.current.timeout = timeout;
    });
    timer.current = { frame, timeout: 0 };
  }, [cancel, evaluate]);

  useEffect(() => {
    const element = container.current;

    const onSelectionChange = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || !readSelection(element)) {
        hide();
        return;
      }
      if (!pointerDown.current) schedule();
    };
    const onContainerPointerDown = () => {
      pointerDown.current = true;
    };
    const onPointerUp = () => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      schedule();
    };
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (popup.current && event.target instanceof Node && popup.current.contains(event.target))
        return;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', hide);
    element?.addEventListener('pointerdown', onContainerPointerDown);
    element?.addEventListener('scroll', hide, { passive: true });
    return () => {
      cancel();
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', hide);
      element?.removeEventListener('pointerdown', onContainerPointerDown);
      element?.removeEventListener('scroll', hide);
    };
  }, [container, hide, schedule, cancel]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: hide when the key changes
  useEffect(() => {
    hide();
  }, [resetKey, hide]);

  // Measure the real popup before paint so the fallback size never shows.
  useLayoutEffect(() => {
    const element = popup.current;
    if (!shown || !element) return;
    const { offsetWidth: width, offsetHeight: height } = element;
    setSize((current) =>
      current.width === width && current.height === height ? current : { width, height },
    );
  }, [shown]);

  if (!shown) return null;
  const { top, left } = placePopup(shown.anchor, size, shown.bounds);

  return createPortal(
    <div
      ref={popup}
      className="selection-actions"
      role="toolbar"
      aria-label={t('selectionActions')}
      style={{ top, left }}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="selection-action"
          // Keep the selection and the focus where they are.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            action.run(shown.text);
            document.getSelection()?.removeAllRanges();
            hide();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
