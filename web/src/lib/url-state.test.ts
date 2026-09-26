import { describe, expect, it } from 'vitest';
import {
  advanceSide,
  closeSide,
  mergeUrlState,
  openSide,
  promoteSide,
  readUrlState,
  remapSideAfterDelete,
  remapSideAfterMove,
  type UrlState,
  writeUrlState,
} from './url-state';

describe('url state', () => {
  it('round-trips tree and node', () => {
    const search = writeUrlState({ tree: 'rust-basics', node: 'ownership/borrowing', side: null });
    expect(search).toBe('?tree=rust-basics&node=ownership/borrowing');
    expect(readUrlState(search)).toEqual({
      tree: 'rust-basics',
      node: 'ownership/borrowing',
      side: null,
    });
  });

  it('drops the node without a tree and defaults to root', () => {
    expect(writeUrlState({ tree: null, node: 'x', side: null })).toBe('');
    expect(readUrlState('?tree=a')).toEqual({ tree: 'a', node: '', side: null });
    expect(readUrlState('')).toEqual({ tree: null, node: '', side: null });
  });
});

describe('side chat url state', () => {
  it('round-trips side and sideNode with unescaped slashes', () => {
    const state: UrlState = {
      tree: 't',
      node: 'a/b',
      side: { anchor: 'a/b', head: 'a/b/c/d' },
    };
    const search = writeUrlState(state);
    expect(search).toBe('?tree=t&node=a/b&side=a/b&sideNode=a/b/c/d');
    expect(readUrlState(search)).toEqual(state);
  });

  it('writes side= for the root anchor', () => {
    const state: UrlState = { tree: 't', node: '', side: { anchor: '', head: null } };
    expect(writeUrlState(state)).toBe('?tree=t&side=');
    expect(readUrlState('?tree=t&side=')).toEqual(state);
  });

  it('omits sideNode while unsent', () => {
    expect(writeUrlState({ tree: 't', node: 'a', side: { anchor: 'a', head: null } })).toBe(
      '?tree=t&node=a&side=a',
    );
  });

  it('accepts any head under the root anchor', () => {
    expect(readUrlState('?tree=t&side=&sideNode=x/y').side).toEqual({ anchor: '', head: 'x/y' });
  });

  it('drops a head outside the anchor subtree or equal to it', () => {
    expect(readUrlState('?tree=t&side=a&sideNode=b/c').side).toEqual({ anchor: 'a', head: null });
    expect(readUrlState('?tree=t&side=a&sideNode=ab').side).toEqual({ anchor: 'a', head: null });
    expect(readUrlState('?tree=t&side=a&sideNode=a').side).toEqual({ anchor: 'a', head: null });
    expect(readUrlState('?tree=t&side=a&sideNode=').side).toEqual({ anchor: 'a', head: null });
  });

  it('ignores side without a tree', () => {
    expect(readUrlState('?side=a&sideNode=a/b')).toEqual({ tree: null, node: '', side: null });
    expect(writeUrlState({ tree: null, node: '', side: { anchor: 'a', head: null } })).toBe('');
  });

  it('reads only the first side entry', () => {
    expect(readUrlState('?tree=t&side=a&sideNode=a/b&side=c&sideNode=c/d').side).toEqual({
      anchor: 'a',
      head: 'a/b',
    });
  });
});

describe('mergeUrlState', () => {
  const current: UrlState = { tree: 't', node: 'a', side: { anchor: 'a', head: 'a/b' } };

  it('clears node and side on a tree switch', () => {
    expect(mergeUrlState(current, { tree: 'u' })).toEqual({ tree: 'u', node: '', side: null });
  });

  it('honours an explicit side on a tree switch', () => {
    const side = { anchor: 'x', head: null };
    expect(mergeUrlState(current, { tree: 'u', node: 'x', side })).toEqual({
      tree: 'u',
      node: 'x',
      side,
    });
  });

  it('keeps side on a node-only change', () => {
    expect(mergeUrlState(current, { node: 'z' })).toEqual({ ...current, node: 'z' });
    expect(mergeUrlState(current, { tree: 't', node: 'z' }).side).toEqual(current.side);
  });
});

describe('side transitions', () => {
  const base: UrlState = { tree: 't', node: 'a', side: null };
  const open: UrlState = { ...base, side: { anchor: 'a', head: null } };

  it('opens unsent on the anchor', () => {
    expect(openSide(base, 'a')).toEqual({ side: { anchor: 'a', head: null } });
  });

  it('advances the head', () => {
    expect(advanceSide(open, 'a/b')).toEqual({ side: { anchor: 'a', head: 'a/b' } });
    expect(advanceSide(open, 'a/b', 'a')).toEqual({ side: { anchor: 'a', head: 'a/b' } });
  });

  it('ignores stale completions', () => {
    expect(advanceSide(base, 'a/b')).toEqual({});
    expect(advanceSide(open, 'a/b', 'other')).toEqual({});
    expect(advanceSide({ ...base, side: { anchor: 'c', head: null } }, 'a/b')).toEqual({});
  });

  it('promotes only after a send', () => {
    expect(promoteSide(open)).toBeNull();
    expect(promoteSide(base)).toBeNull();
    expect(promoteSide({ ...base, side: { anchor: 'a', head: 'a/b' } })).toEqual({
      node: 'a/b',
      side: null,
    });
  });

  it('closes', () => {
    expect(closeSide()).toEqual({ side: null });
  });
});

describe('side remapping', () => {
  const side = { anchor: 'a/b', head: 'a/b/c/d' };

  it('follows a moved anchor', () => {
    expect(remapSideAfterMove(side, { 'a/b': 'x/b' })).toEqual({
      anchor: 'x/b',
      head: 'x/b/c/d',
    });
  });

  it('follows a moved ancestor of the anchor', () => {
    expect(remapSideAfterMove(side, { a: 'z/a' })).toEqual({ anchor: 'z/a/b', head: 'z/a/b/c/d' });
  });

  it('drops a head moved out of the side branch', () => {
    expect(remapSideAfterMove(side, { 'a/b/c': 'q/c' })).toEqual({ anchor: 'a/b', head: null });
  });

  it('keeps the head when it moves within the branch', () => {
    expect(remapSideAfterMove(side, { 'a/b/c/d': 'a/b/d' })).toEqual({
      anchor: 'a/b',
      head: 'a/b/d',
    });
  });

  it('returns the same object when a move does not touch it', () => {
    expect(remapSideAfterMove(side, { q: 'r/q' })).toBe(side);
  });

  it('keeps a deleted anchor so the panel can report it', () => {
    expect(remapSideAfterDelete(side, ['a/b'])).toBe(side);
    expect(remapSideAfterDelete(side, ['a'])).toBe(side);
  });

  it('falls back when the head is deleted', () => {
    expect(remapSideAfterDelete(side, ['a/b/c/d'])).toEqual({ anchor: 'a/b', head: 'a/b/c' });
    expect(remapSideAfterDelete(side, ['a/b/c'])).toEqual({ anchor: 'a/b', head: null });
  });

  it('returns the same object when a delete does not touch it', () => {
    expect(remapSideAfterDelete(side, ['q'])).toBe(side);
    const unsent = { anchor: 'a', head: null };
    expect(remapSideAfterDelete(unsent, ['a/x'])).toBe(unsent);
  });
});
