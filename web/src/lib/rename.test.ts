import { describe, expect, it } from 'vitest';
import { canSubmitRename, MAX_NAME_LENGTH, renameTargetOf, treePatchOf } from './rename';

describe('renameTargetOf', () => {
  it('uses the single selected node', () => {
    expect(renameTargetOf(['a/b'], 'c')).toBe('a/b');
    expect(renameTargetOf(new Set(['a/b']), '')).toBe('a/b');
  });

  it('falls back to the current node when nothing is selected', () => {
    expect(renameTargetOf([], 'a/b')).toBe('a/b');
  });

  it('never targets the root', () => {
    expect(renameTargetOf([], '')).toBeNull();
  });

  it('is null for several selected nodes', () => {
    expect(renameTargetOf(['a', 'b'], 'a')).toBeNull();
  });
});

describe('canSubmitRename', () => {
  it('rejects blank, unchanged and too long input', () => {
    expect(canSubmitRename('foo', '')).toBe(false);
    expect(canSubmitRename('foo', '   ')).toBe(false);
    expect(canSubmitRename('foo', 'foo')).toBe(false);
    expect(canSubmitRename('foo', ' foo ')).toBe(false);
    expect(canSubmitRename('foo', 'x'.repeat(MAX_NAME_LENGTH + 1))).toBe(false);
  });

  it('accepts a changed name', () => {
    expect(canSubmitRename('foo', 'Foo Bar')).toBe(true);
    expect(canSubmitRename('foo', 'x'.repeat(MAX_NAME_LENGTH))).toBe(true);
  });
});

describe('treePatchOf', () => {
  const tree = { title: 'Rust', instructions: 'Be brief.' };

  it('sends only the title when only it changed', () => {
    expect(treePatchOf(tree, ' Rust basics ', 'Be brief.')).toEqual({ title: 'Rust basics' });
  });

  it('sends only instructions when only they changed', () => {
    expect(treePatchOf(tree, 'Rust', 'Be long. ')).toEqual({ instructions: 'Be long. ' });
  });

  it('sends both when both changed', () => {
    expect(treePatchOf(tree, 'Go', '')).toEqual({ title: 'Go', instructions: '' });
  });

  it('is null when nothing changed', () => {
    expect(treePatchOf(tree, ' Rust ', 'Be brief.  ')).toBeNull();
  });

  it('never sends a blank title', () => {
    expect(treePatchOf(tree, '  ', 'Be brief.')).toBeNull();
    expect(treePatchOf(tree, '', 'x')).toEqual({ instructions: 'x' });
  });
});
