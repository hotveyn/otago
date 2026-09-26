import { describe, expect, it } from 'vitest';
import type { HierarchyNode } from '../../api/types';
import { ghostKey, layoutTree, ROOT_KEY } from './layout';

const node = (id: string, created: string, children: HierarchyNode[] = []): HierarchyNode => ({
  id,
  name: id.split('/').pop() ?? id,
  created,
  children,
});

const a = node('a', '2026-01-01T00:00:00Z', [node('a/x', '2026-01-02T00:00:00Z')]);
const b = node('b', '2026-01-03T00:00:00Z');
const tree = [a, b];

describe('layoutTree ghost', () => {
  it('adds no ghost without a ghost parent', () => {
    const { nodes, edges } = layoutTree('T', tree);
    expect(nodes.some((n) => n.data.ghost)).toBe(false);
    expect(edges).toHaveLength(3);
  });

  it('puts the ghost where the next child of the parent will appear', () => {
    const { nodes, edges } = layoutTree('T', tree, 'a');
    const ghost = nodes.find((n) => n.data.ghost);
    const sibling = nodes.find((n) => n.id === 'a/x');
    expect(ghost?.id).toBe(ghostKey('a'));
    expect(ghost?.draggable).toBe(false);
    expect(edges).toContainEqual(expect.objectContaining({ source: 'a', target: ghostKey('a') }));
    expect(ghost?.position.y).toBe(sibling?.position.y);

    // Same side of the existing sibling as a real newest child.
    const next = node('a/y', '2026-01-04T00:00:00Z');
    const real = layoutTree('T', [{ ...a, children: [...a.children, next] }, b]).nodes;
    const realNext = real.find((n) => n.id === 'a/y');
    const realSibling = real.find((n) => n.id === 'a/x');
    const side = (x = 0, y = 0) => Math.sign(x - y);
    expect(side(ghost?.position.x, sibling?.position.x)).toBe(
      side(realNext?.position.x, realSibling?.position.x),
    );
  });

  it('hangs the ghost off the root and under leaves', () => {
    expect(layoutTree('T', tree, '').edges).toContainEqual(
      expect.objectContaining({ source: ROOT_KEY, target: ghostKey(ROOT_KEY) }),
    );
    expect(layoutTree('T', tree, 'b').edges).toContainEqual(
      expect.objectContaining({ source: 'b', target: ghostKey('b') }),
    );
  });

  it('adds no ghost for an unknown node', () => {
    expect(layoutTree('T', tree, 'missing').nodes.some((n) => n.data.ghost)).toBe(false);
  });
});
