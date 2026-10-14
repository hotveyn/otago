import { describe, expect, it } from 'vitest';
import type { QuestionInfo } from '../api/types';
import { initialScrollAnchor, nextScrollAnchor } from './chat-scroll';

const done = (id: string, nodeId: string): QuestionInfo =>
  ({ id, status: 'done', nodeId }) as unknown as QuestionInfo;
const streaming = (id: string): QuestionInfo =>
  ({ id, status: 'streaming' }) as unknown as QuestionInfo;

describe('nextScrollAnchor', () => {
  it('keeps the same anchor while the node does not change', () => {
    const anchor = initialScrollAnchor('a', null);
    expect(nextScrollAnchor(anchor, 'a', null, {})).toBe(anchor);
  });

  it('remembers the focused question', () => {
    const anchor = nextScrollAnchor(initialScrollAnchor('a', null), 'a', 'q1', {});
    expect(anchor).toEqual({ node: 'a', key: 'a', focus: 'q1' });
    expect(nextScrollAnchor(anchor, 'a', null, {})).toBe(anchor);
  });

  it('changes the key when the user switches nodes', () => {
    const anchor = initialScrollAnchor('a', null);
    expect(nextScrollAnchor(anchor, 'a/b', null, {})).toEqual({
      node: 'a/b',
      key: 'a/b',
      focus: null,
    });
  });

  it('keeps the key when the URL follows the saved answer of the focused question', () => {
    const anchor = nextScrollAnchor(initialScrollAnchor('a', null), 'a', 'q1', {});
    const next = nextScrollAnchor(anchor, 'a/new', null, { q1: done('q1', 'a/new') });
    expect(next).toEqual({ node: 'a/new', key: 'a', focus: 'q1' });
    // The next real switch jumps again.
    expect(nextScrollAnchor(next, 'a', null, { q1: done('q1', 'a/new') }).key).toBe('a');
    expect(nextScrollAnchor(next, 'c', null, { q1: done('q1', 'a/new') }).key).toBe('c');
  });

  it('changes the key when the user clicks away while the focused question streams', () => {
    const anchor = nextScrollAnchor(initialScrollAnchor('a', null), 'a', 'q1', {});
    expect(nextScrollAnchor(anchor, 'a/other', null, { q1: streaming('q1') }).key).toBe('a/other');
  });

  it('changes the key when the saved answer landed elsewhere', () => {
    const anchor = nextScrollAnchor(initialScrollAnchor('a', null), 'a', 'q1', {});
    expect(nextScrollAnchor(anchor, 'a/x', null, { q1: done('q1', 'a/y') }).key).toBe('a/x');
  });
});
