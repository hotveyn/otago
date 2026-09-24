import { describe, expect, it } from 'vitest';
import type { HierarchyNode } from '../api/types';
import {
  afterDelete,
  afterMove,
  canMoveTo,
  chainIds,
  countWithDescendants,
  findNode,
  flatten,
  topLevelIds,
} from './tree';

const n = (id: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id,
  name: id.slice(id.lastIndexOf('/') + 1),
  created: '2026-09-23T10:00:00.000Z',
  children,
});

const nodes = [n('a', [n('a/b', [n('a/b/c')]), n('a/d')]), n('e')];

describe('tree helpers', () => {
  it('builds chain ids', () => {
    expect(chainIds('')).toEqual([]);
    expect(chainIds('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('flattens with depth and finds nodes', () => {
    expect(flatten(nodes).map((x) => `${x.depth}:${x.node.id}`)).toEqual([
      '0:a',
      '1:a/b',
      '2:a/b/c',
      '1:a/d',
      '0:e',
    ]);
    expect(findNode(nodes, 'a/b/c')?.name).toBe('c');
    expect(findNode(nodes, 'a/x')).toBeUndefined();
  });

  it('keeps only top-level selected ids', () => {
    expect(topLevelIds(['a/b/c', 'a', 'e', 'a'])).toEqual(['a', 'e']);
    expect(topLevelIds(['a/b', 'a/bb'])).toEqual(['a/b', 'a/bb']);
  });

  it('counts nodes including descendants', () => {
    expect(countWithDescendants(nodes, ['a/b'])).toBe(2);
    expect(countWithDescendants(nodes, ['a', 'a/b/c', 'e'])).toBe(5);
  });

  it('moves the current node to its nearest surviving ancestor after delete', () => {
    expect(afterDelete('a/b/c', ['a/b'])).toBe('a');
    expect(afterDelete('a/b/c', ['a/b/c'])).toBe('a/b');
    expect(afterDelete('a/b/c', ['a', 'a/b'])).toBe('');
    expect(afterDelete('a/d', ['a/b'])).toBe('a/d');
    expect(afterDelete('', ['a'])).toBe('');
  });

  it('follows the current node after move', () => {
    expect(afterMove('a/b/c', { 'a/b': 'e/b-2' })).toBe('e/b-2/c');
    expect(afterMove('a/b', { 'a/b': 'b' })).toBe('b');
    expect(afterMove('a/bb', { 'a/b': 'b' })).toBe('a/bb');
  });

  it('validates move targets', () => {
    expect(canMoveTo(['a/b'], 'e')).toBe(true);
    expect(canMoveTo(['a/b'], '')).toBe(true);
    expect(canMoveTo(['a/b'], 'a/b')).toBe(false);
    expect(canMoveTo(['a/b'], 'a/b/c')).toBe(false);
    expect(canMoveTo(['e', 'a'], 'a/d')).toBe(false);
    expect(canMoveTo([], 'e')).toBe(false);
  });
});
