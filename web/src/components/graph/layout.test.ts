import { describe, expect, it } from 'vitest';
import type { HierarchyNode } from '../../api/types';
import type { PendingBox } from '../../lib/questions';
import { ghostKey, isPendingFlowId, layoutTree, pendingFlowId, ROOT_KEY } from './layout';

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

const pendingBox = (key: string, parentId: string, createdAt: string): PendingBox => ({
  key,
  questionId: key,
  outboxId: null,
  parentId,
  context: { kind: 'main' },
  label: `Question ${key}`,
  createdAt,
  nodeId: null,
});

describe('layoutTree pending boxes', () => {
  const later = pendingBox('q2', 'a', '2026-01-05T00:00:00Z');
  const earlier = pendingBox('q1', 'a', '2026-01-04T00:00:00Z');

  it('puts pending boxes after the real children, by createdAt, before the ghost', () => {
    const { nodes, edges } = layoutTree('T', tree, 'a', [later, earlier]);
    // The same slots real children created at those times would take.
    const real = layoutTree(
      'T',
      [
        {
          ...a,
          children: [
            ...a.children,
            node('a/y', '2026-01-04T00:00:00Z'),
            node('a/z', '2026-01-05T00:00:00Z'),
          ],
        },
        b,
      ],
      'a',
    ).nodes;
    const xs = (list: typeof nodes, ids: string[]) =>
      ids.map((id) => list.find((n) => n.id === id)?.position.x ?? Number.NaN);
    const direction = (values: number[]) =>
      values.slice(1).map((value, index) => Math.sign(value - (values[index] ?? 0)));
    const pendingOrder = xs(nodes, [
      'a/x',
      pendingFlowId('q1'),
      pendingFlowId('q2'),
      ghostKey('a'),
    ]);
    const realOrder = xs(real, ['a/x', 'a/y', 'a/z', ghostKey('a')]);
    expect(direction(pendingOrder)).toEqual(direction(realOrder));
    expect(new Set(direction(pendingOrder)).size).toBe(1);
    expect(edges).toContainEqual(
      expect.objectContaining({
        id: `edge:${pendingFlowId('q1')}`,
        source: 'a',
        target: pendingFlowId('q1'),
      }),
    );
  });

  it('marks pending boxes and keeps them out of drag and selection', () => {
    const box = layoutTree('T', tree, null, [earlier]).nodes.find((n) => isPendingFlowId(n.id));
    expect(box?.id).toBe('__q__:q1');
    expect(box?.draggable).toBe(false);
    expect(box?.selectable).toBe(false);
    expect(box?.data).toEqual(
      expect.objectContaining({ nodeId: '', pendingKey: 'q1', label: 'Question q1', ghost: false }),
    );
  });

  it('hangs root questions off the root and skips unknown parents', () => {
    const { nodes, edges } = layoutTree('T', tree, null, [
      pendingBox('r', '', '2026-01-04T00:00:00Z'),
      pendingBox('m', 'missing', '2026-01-04T00:00:00Z'),
    ]);
    expect(edges).toContainEqual(expect.objectContaining({ source: ROOT_KEY, target: '__q__:r' }));
    expect(nodes.some((n) => n.id === '__q__:m')).toBe(false);
  });

  it('keeps pending boxes to one line', () => {
    const long = { ...earlier, label: 'word '.repeat(40) };
    const box = layoutTree('T', tree, null, [long]).nodes.find((n) => isPendingFlowId(n.id));
    const real = layoutTree('T', [
      node('a', '2026-01-01T00:00:00Z', [node(`a/${'word-'.repeat(40)}`, 'x')]),
    ]).nodes.find((n) => n.id.startsWith('a/'));
    expect(box?.height).toBeLessThan(real?.height ?? 0);
    expect(box?.width).toBeLessThanOrEqual(240);
  });

  it('is deterministic for the same input', () => {
    const first = layoutTree('T', tree, 'a', [earlier, later]);
    const second = layoutTree('T', tree, 'a', [later, earlier]);
    expect(second.nodes.map((n) => [n.id, n.position])).toEqual(
      first.nodes.map((n) => [n.id, n.position]),
    );
  });
});
