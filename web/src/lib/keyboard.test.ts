import { describe, expect, it } from 'vitest';
import { isEditableTarget, isUndoShortcut, type KeyLike, shouldHandleTreeUndo } from './keyboard';

const key = (overrides: Partial<KeyLike> = {}): KeyLike => ({
  key: 'z',
  metaKey: false,
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({
  tagName,
  closest: () => null,
  ...extra,
});

describe('isUndoShortcut', () => {
  it('accepts Ctrl+Z and Meta+Z', () => {
    expect(isUndoShortcut(key())).toBe(true);
    expect(isUndoShortcut(key({ ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it('accepts uppercase Z (caps lock)', () => {
    expect(isUndoShortcut(key({ key: 'Z' }))).toBe(true);
  });

  it('rejects Shift, Alt, a plain z and other keys', () => {
    expect(isUndoShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isUndoShortcut(key({ altKey: true }))).toBe(false);
    expect(isUndoShortcut(key({ ctrlKey: false }))).toBe(false);
    expect(isUndoShortcut(key({ key: 'y' }))).toBe(false);
  });
});

describe('shouldHandleTreeUndo', () => {
  it('handles a plain shortcut on the page', () => {
    expect(shouldHandleTreeUndo(key({ target: el('DIV') }))).toBe(true);
    expect(shouldHandleTreeUndo(key())).toBe(true);
  });

  it('skips repeats, prevented and composing events', () => {
    expect(shouldHandleTreeUndo(key({ repeat: true }))).toBe(false);
    expect(shouldHandleTreeUndo(key({ defaultPrevented: true }))).toBe(false);
    expect(shouldHandleTreeUndo(key({ isComposing: true }))).toBe(false);
  });

  it('leaves editable targets to the native text undo', () => {
    expect(shouldHandleTreeUndo(key({ target: el('TEXTAREA') }))).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('detects text fields', () => {
    expect(isEditableTarget(el('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isEditableTarget(el('INPUT'))).toBe(true);
    expect(isEditableTarget(el('SELECT'))).toBe(true);
  });

  it('detects contenteditable elements and their children', () => {
    expect(isEditableTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(el('SPAN', { closest: () => ({}) }))).toBe(true);
  });

  it('ignores non-text controls and plain elements', () => {
    expect(isEditableTarget(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isEditableTarget(el('BUTTON'))).toBe(false);
    expect(isEditableTarget(el('DIV'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});
