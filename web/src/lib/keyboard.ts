/** Structural subset of `KeyboardEvent` used by the predicates (testable without a DOM). */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

/** Ctrl+Z or ⌘+Z on every OS; Shift is left for a future redo, Alt is excluded. */
export const isUndoShortcut = (e: KeyLike): boolean =>
  (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';

const NON_TEXT_INPUTS = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'range',
  'color',
  'file',
]);

/** True when the target has its own native text undo (text inputs, textareas, editables). */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function')
    return Boolean(el.closest('[contenteditable=""],[contenteditable="true"]'));
  return false;
}

/** Should this keydown trigger a tree undo (not a native text undo, not a held key)? */
export const shouldHandleTreeUndo = (e: KeyLike): boolean =>
  isUndoShortcut(e) &&
  !e.repeat &&
  !e.defaultPrevented &&
  !e.isComposing &&
  !isEditableTarget(e.target);
