import { describe, expect, it } from 'vitest';
import {
  closeSide,
  followTreeRename,
  mergeUrlState,
  openSide,
  promoteSide,
  readUrlState,
  remapSideAfterDelete,
  remapSideAfterMove,
  type SideChatState,
  type UrlState,
  writeUrlState,
} from './url-state';

const side = (anchor: string, head: string | null = null, question: string | null = null) => ({
  anchor,
  head,
  question,
});

const url = (partial: Partial<UrlState> = {}): UrlState => ({
  tree: 't',
  node: '',
  question: null,
  side: null,
  ...partial,
});

describe('url state', () => {
  it('round-trips tree and node', () => {
    const search = writeUrlState(url({ tree: 'rust-basics', node: 'ownership/borrowing' }));
    expect(search).toBe('?tree=rust-basics&node=ownership/borrowing');
    expect(readUrlState(search)).toEqual(url({ tree: 'rust-basics', node: 'ownership/borrowing' }));
  });

  it('drops the node without a tree and defaults to root', () => {
    expect(writeUrlState(url({ tree: null, node: 'x' }))).toBe('');
    expect(readUrlState('?tree=a')).toEqual(url({ tree: 'a' }));
    expect(readUrlState('')).toEqual(url({ tree: null }));
  });

  it('round-trips the main focus as q', () => {
    const state = url({ node: 'a/b', question: 'q-1' });
    const search = writeUrlState(state);
    expect(search).toBe('?tree=t&node=a/b&q=q-1');
    expect(readUrlState(search)).toEqual(state);
  });

  it('ignores q without a tree and an empty q', () => {
    expect(readUrlState('?q=q-1').question).toBeNull();
    expect(writeUrlState(url({ tree: null, question: 'q-1' }))).toBe('');
    expect(readUrlState('?tree=t&q=').question).toBeNull();
  });

  it('writes tree, node, q, side, sideNode, sideQ in this order', () => {
    expect(writeUrlState(url({ node: 'a', question: 'm', side: side('a', 'a/b', 's') }))).toBe(
      '?tree=t&node=a&q=m&side=a&sideNode=a/b&sideQ=s',
    );
  });

  it('normalizes NFD ids to NFC', () => {
    const nfc = 'основы/йод';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    const params = new URLSearchParams({ tree: 't', node: nfd, side: nfd, sideNode: `${nfd}/ёж` });
    const state = readUrlState(`?${params}`);
    expect(state.node).toBe(nfc);
    expect(state.side).toEqual(side(nfc, `${nfc}/ёж`.normalize('NFC')));
  });

  it('round-trips Cyrillic ids with unescaped slashes', () => {
    const state = url({ node: 'основы/заимствование', side: side('основы', 'основы/правила') });
    const search = writeUrlState(state);
    expect(search).toContain('/');
    expect(search).not.toContain('%2F');
    expect(readUrlState(search)).toEqual(state);
  });
});

describe('side chat url state', () => {
  it('round-trips side and sideNode with unescaped slashes', () => {
    const state = url({ node: 'a/b', side: side('a/b', 'a/b/c/d') });
    const search = writeUrlState(state);
    expect(search).toBe('?tree=t&node=a/b&side=a/b&sideNode=a/b/c/d');
    expect(readUrlState(search)).toEqual(state);
  });

  it('round-trips sideQ', () => {
    const state = url({ side: side('a', null, 's-1') });
    expect(writeUrlState(state)).toBe('?tree=t&side=a&sideQ=s-1');
    expect(readUrlState('?tree=t&side=a&sideQ=s-1')).toEqual(state);
  });

  it('ignores sideQ without a side', () => {
    expect(readUrlState('?tree=t&sideQ=s-1').side).toBeNull();
  });

  it('writes side= for the root anchor', () => {
    const state = url({ side: side('') });
    expect(writeUrlState(state)).toBe('?tree=t&side=');
    expect(readUrlState('?tree=t&side=')).toEqual(state);
  });

  it('omits sideNode while unsent', () => {
    expect(writeUrlState(url({ node: 'a', side: side('a') }))).toBe('?tree=t&node=a&side=a');
  });

  it('accepts any head under the root anchor', () => {
    expect(readUrlState('?tree=t&side=&sideNode=x/y').side).toEqual(side('', 'x/y'));
  });

  it('drops a head outside the anchor subtree or equal to it', () => {
    expect(readUrlState('?tree=t&side=a&sideNode=b/c').side).toEqual(side('a'));
    expect(readUrlState('?tree=t&side=a&sideNode=ab').side).toEqual(side('a'));
    expect(readUrlState('?tree=t&side=a&sideNode=a').side).toEqual(side('a'));
    expect(readUrlState('?tree=t&side=a&sideNode=').side).toEqual(side('a'));
  });

  it('ignores side without a tree', () => {
    expect(readUrlState('?side=a&sideNode=a/b')).toEqual(url({ tree: null }));
    expect(writeUrlState(url({ tree: null, side: side('a') }))).toBe('');
  });

  it('reads only the first side entry', () => {
    expect(
      readUrlState('?tree=t&side=a&sideNode=a/b&sideQ=x&side=c&sideNode=c/d&sideQ=y').side,
    ).toEqual(side('a', 'a/b', 'x'));
  });
});

describe('mergeUrlState', () => {
  const current = url({ node: 'a', question: 'q', side: side('a', 'a/b') });

  it('clears node, question and side on a tree switch', () => {
    expect(mergeUrlState(current, { tree: 'u' })).toEqual(url({ tree: 'u' }));
  });

  it('honours an explicit side and question on a tree switch', () => {
    const next = side('x');
    expect(mergeUrlState(current, { tree: 'u', node: 'x', side: next, question: 'z' })).toEqual(
      url({ tree: 'u', node: 'x', side: next, question: 'z' }),
    );
  });

  it('keeps side on a node-only change but leaves the focus', () => {
    expect(mergeUrlState(current, { node: 'z' })).toEqual({
      ...current,
      node: 'z',
      question: null,
    });
    expect(mergeUrlState(current, { tree: 't', node: 'z' }).side).toEqual(current.side);
  });

  it('keeps the focus when a node change gives it', () => {
    expect(mergeUrlState(current, { node: 'z', question: 'q' })).toEqual({ ...current, node: 'z' });
  });

  it('keeps the focus on a same-node update', () => {
    expect(mergeUrlState(current, { node: 'a' }).question).toBe('q');
    expect(mergeUrlState(current, { side: null }).question).toBe('q');
  });
});

describe('side transitions', () => {
  const base = url({ node: 'a' });
  const open = url({ node: 'a', side: side('a') });

  it('opens unsent on the anchor with no question', () => {
    expect(openSide(base, 'a')).toEqual({ side: side('a') });
  });

  it('promotes only after a send and without a question in flight', () => {
    expect(promoteSide(open)).toBeNull();
    expect(promoteSide(base)).toBeNull();
    expect(promoteSide(url({ node: 'a', side: side('a', 'a/b', 'q') }))).toBeNull();
    expect(promoteSide(url({ node: 'a', question: 'm', side: side('a', 'a/b') }))).toEqual({
      node: 'a/b',
      question: null,
      side: null,
    });
  });

  it('closes', () => {
    expect(closeSide()).toEqual({ side: null });
  });
});

describe('side remapping', () => {
  const remapped: SideChatState = side('a/b', 'a/b/c/d', 'q');

  it('follows a moved anchor and keeps the question', () => {
    expect(remapSideAfterMove(remapped, { 'a/b': 'x/b' })).toEqual(side('x/b', 'x/b/c/d', 'q'));
  });

  it('follows a moved ancestor of the anchor', () => {
    expect(remapSideAfterMove(remapped, { a: 'z/a' })).toEqual(side('z/a/b', 'z/a/b/c/d', 'q'));
  });

  it('drops a head moved out of the side branch', () => {
    expect(remapSideAfterMove(remapped, { 'a/b/c': 'q/c' })).toEqual(side('a/b', null, 'q'));
  });

  it('keeps the head when it moves within the branch', () => {
    expect(remapSideAfterMove(remapped, { 'a/b/c/d': 'a/b/d' })).toEqual(side('a/b', 'a/b/d', 'q'));
  });

  it('returns the same object when a move does not touch it', () => {
    expect(remapSideAfterMove(remapped, { q: 'r/q' })).toBe(remapped);
  });

  it('keeps a deleted anchor so the panel can report it', () => {
    expect(remapSideAfterDelete(remapped, ['a/b'])).toBe(remapped);
    expect(remapSideAfterDelete(remapped, ['a'])).toBe(remapped);
  });

  it('falls back when the head is deleted, keeping the question', () => {
    expect(remapSideAfterDelete(remapped, ['a/b/c/d'])).toEqual(side('a/b', 'a/b/c', 'q'));
    expect(remapSideAfterDelete(remapped, ['a/b/c'])).toEqual(side('a/b', null, 'q'));
  });

  it('returns the same object when a delete does not touch it', () => {
    expect(remapSideAfterDelete(remapped, ['q'])).toBe(remapped);
    const unsent = side('a');
    expect(remapSideAfterDelete(unsent, ['a/x'])).toBe(unsent);
  });

  it('respects Cyrillic segment boundaries', () => {
    const cyr = side('основы', 'основы/правила');
    expect(remapSideAfterMove(cyr, { 'основы-2': 'x' })).toBe(cyr);
    expect(remapSideAfterMove(cyr, { основы: 'база' })).toEqual(side('база', 'база/правила'));
  });
});

describe('tree rename', () => {
  const state = url({
    tree: 'rust-basics',
    node: 'a/b',
    question: 'q',
    side: side('a', 'a/b', 's'),
  });

  it('keeps node, question and side and switches the tree', () => {
    expect(followTreeRename(state, 'rust-basics', 'rust')).toEqual({
      tree: 'rust',
      node: 'a/b',
      question: 'q',
      side: side('a', 'a/b', 's'),
    });
  });

  it('does nothing when another tree is shown', () => {
    expect(followTreeRename(state, 'go', 'golang')).toEqual({});
  });

  it('round-trips through mergeUrlState and writeUrlState', () => {
    const merged = mergeUrlState(state, followTreeRename(state, 'rust-basics', 'rust'));
    expect(writeUrlState(merged)).toBe('?tree=rust&node=a/b&q=q&side=a&sideNode=a/b&sideQ=s');
  });
});

describe('side remapping after a node rename', () => {
  const renamed = { a: 'b', 'a/x': 'b/x', 'a/x/y': 'b/x/y' };

  it('follows an anchor inside the renamed subtree', () => {
    expect(remapSideAfterMove(side('a/x', 'a/x/y'), renamed)).toEqual(side('b/x', 'b/x/y'));
  });

  it('follows a head inside the renamed subtree', () => {
    expect(remapSideAfterMove(side('q', 'q/a'), { 'q/a': 'q/z' })).toEqual(side('q', 'q/z'));
  });

  it('follows an anchor that is the renamed node', () => {
    expect(remapSideAfterMove(side('a'), renamed)).toEqual(side('b'));
  });

  it('returns the same object for an identity map', () => {
    const unchanged = side('a', 'a/x');
    expect(remapSideAfterMove(unchanged, { a: 'a', 'a/x': 'a/x' })).toBe(unchanged);
  });
});
