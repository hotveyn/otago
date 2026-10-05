import { describe, expect, it } from 'vitest';
import { createDraftStash, mergeDraft, stashKeyOf } from './draft-stash';

const file = (id: number) => ({ id, file: new File(['x'], `f${id}.pdf`) });

describe('stashKeyOf', () => {
  it('keys the main chat per tree and asides per anchor', () => {
    expect(stashKeyOf('t', { kind: 'main' })).toBe('t:main');
    expect(stashKeyOf('t', { kind: 'side', anchor: 'основы/a' })).toBe('t:side:основы/a');
    expect(stashKeyOf('t', { kind: 'side', anchor: '' })).toBe('t:side:');
  });
});

describe('draft stash', () => {
  it('gets, sets and clears; an empty draft deletes the key', () => {
    const stash = createDraftStash();
    expect(stash.get('k')).toBeNull();
    const draft = { text: 'draft', files: [file(1)] };
    stash.set('k', draft);
    expect(stash.get('k')).toBe(draft);
    stash.set('k', { text: '  ', files: [] });
    expect(stash.get('k')).toBeNull();
    stash.set('k', { text: '', files: [file(2)] });
    expect(stash.get('k')?.files).toHaveLength(1);
    stash.set('k', null);
    expect(stash.get('k')).toBeNull();
    stash.set('a', draft);
    stash.clear();
    expect(stash.get('a')).toBeNull();
  });
});

describe('mergeDraft', () => {
  const restored = { text: 'sent text', files: [file(3)] };

  it('restores into an empty draft', () => {
    expect(mergeDraft(null, restored)).toEqual(restored);
    expect(mergeDraft({ text: ' ', files: [] }, restored)).toEqual(restored);
  });

  it('keeps text and files typed meanwhile', () => {
    const current = { text: 'new text', files: [file(4)] };
    expect(mergeDraft(current, restored)).toEqual(current);
    expect(mergeDraft({ text: 'new', files: [] }, restored)).toEqual({
      text: 'new',
      files: restored.files,
    });
  });
});
