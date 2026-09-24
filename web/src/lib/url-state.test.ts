import { describe, expect, it } from 'vitest';
import { readUrlState, writeUrlState } from './url-state';

describe('url state', () => {
  it('round-trips tree and node', () => {
    const search = writeUrlState({ tree: 'rust-basics', node: 'ownership/borrowing' });
    expect(search).toBe('?tree=rust-basics&node=ownership/borrowing');
    expect(readUrlState(search)).toEqual({ tree: 'rust-basics', node: 'ownership/borrowing' });
  });

  it('drops the node without a tree and defaults to root', () => {
    expect(writeUrlState({ tree: null, node: 'x' })).toBe('');
    expect(readUrlState('?tree=a')).toEqual({ tree: 'a', node: '' });
    expect(readUrlState('')).toEqual({ tree: null, node: '' });
  });
});
