import { describe, expect, it } from 'vitest';
import type { ChainNode } from '../api/types';
import { canPromote, sideParent, sideThread } from './side-chat';

const node = (id: string): ChainNode => ({
  id,
  name: id.split('/').pop() ?? id,
  created: '',
  model: '',
  user: 'q',
  assistant: 'a',
  attachments: [],
  files: [],
});

const chain = ['a', 'a/b', 'a/b/c', 'a/b/c/d'].map(node);

describe('sideThread', () => {
  it('returns the whole chain for the root anchor', () => {
    expect(sideThread(chain, '')).toBe(chain);
  });

  it('returns the nodes after a middle anchor', () => {
    expect(sideThread(chain, 'a/b').map((n) => n.id)).toEqual(['a/b/c', 'a/b/c/d']);
    expect(sideThread(chain, 'a/b/c/d')).toEqual([]);
  });

  it('returns nothing when the anchor is not in the chain', () => {
    expect(sideThread(chain, 'x')).toEqual([]);
  });
});

describe('sideParent', () => {
  it('uses the head, else the anchor', () => {
    expect(sideParent({ anchor: 'a', head: null })).toBe('a');
    expect(sideParent({ anchor: 'a', head: 'a/b' })).toBe('a/b');
    expect(sideParent({ anchor: '', head: null })).toBe('');
  });
});

describe('canPromote', () => {
  it('needs a head and no stream', () => {
    expect(canPromote({ anchor: 'a', head: null }, false)).toBe(false);
    expect(canPromote({ anchor: 'a', head: 'a/b' }, true)).toBe(false);
    expect(canPromote({ anchor: 'a', head: 'a/b' }, false)).toBe(true);
  });
});
