import { Graph, layout } from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { HierarchyNode } from '../../api/types';

export const ROOT_KEY = '__root__';

export const toFlowId = (id: string) => (id === '' ? ROOT_KEY : id);
export const fromFlowId = (id: string) => (id === ROOT_KEY ? '' : id);

export interface BoxData extends Record<string, unknown> {
  nodeId: string;
  label: string;
  isRoot: boolean;
  childCount: number;
  current: boolean;
  inChain: boolean;
  selected: boolean;
  dropTarget: boolean;
}

export type BoxNode = Node<BoxData, 'box'>;

const NODE_HEIGHT = 27;
const CHAR_WIDTH = 5.9;

function widthOf(label: string, isRoot: boolean): number {
  return Math.min(192, Math.max(isRoot ? 88 : 64, Math.round(label.length * CHAR_WIDTH + 22)));
}

/** Top-down tree layout. Positions are node top-left corners, as React Flow expects. */
export function layoutTree(
  title: string,
  nodes: HierarchyNode[],
): { nodes: BoxNode[]; edges: Edge[] } {
  const graph = new Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 14, ranksep: 37, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));

  const boxes: { id: string; label: string; isRoot: boolean; childCount: number }[] = [];
  const edges: Edge[] = [];

  const visit = (list: HierarchyNode[], parentFlowId: string) => {
    for (const node of list) {
      boxes.push({
        id: node.id,
        label: node.name,
        isRoot: false,
        childCount: node.children.length,
      });
      edges.push({ id: `${parentFlowId}->${node.id}`, source: parentFlowId, target: node.id });
      visit(node.children, node.id);
    }
  };
  boxes.push({ id: ROOT_KEY, label: title, isRoot: true, childCount: nodes.length });
  visit(nodes, ROOT_KEY);

  for (const box of boxes) {
    graph.setNode(box.id, { width: widthOf(box.label, box.isRoot), height: NODE_HEIGHT });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  layout(graph);

  return {
    nodes: boxes.map((box) => {
      const { x, y, width, height } = graph.node(box.id);
      return {
        id: box.id,
        type: 'box',
        position: { x: x - width / 2, y: y - height / 2 },
        width,
        height,
        draggable: !box.isRoot,
        data: {
          nodeId: fromFlowId(box.id),
          label: box.label,
          isRoot: box.isRoot,
          childCount: box.childCount,
          current: false,
          inChain: false,
          selected: false,
          dropTarget: false,
        },
      };
    }),
    edges,
  };
}
