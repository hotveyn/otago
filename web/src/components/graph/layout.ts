import { Graph, layout } from '@dagrejs/dagre';
import type { Node } from '@xyflow/react';
import type { HierarchyNode } from '../../api/types';
import type { TreeEdgeType } from './TreeEdge';

export const ROOT_KEY = '__root__';
const GHOST_PREFIX = '__ghost__:';

/** Flow id of the placeholder for the next child of `parentFlowId`. */
export const ghostKey = (parentFlowId: string) => `${GHOST_PREFIX}${parentFlowId}`;
export const isGhostKey = (id: string) => id.startsWith(GHOST_PREFIX);

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
  busy: boolean;
  /** Placeholder for where the next answer under the current node will appear. */
  ghost: boolean;
  /** Distance from the root; staggers the entrance animation. */
  depth: number;
}

export type BoxNode = Node<BoxData, 'box'>;

const LINE_HEIGHT = 13;
const PAD_X = 22;
const PAD_Y = 14;
const MAX_WIDTH = 240;
const MAX_LINES = 3;
/** Rough glyph width, used only where canvas is unavailable (tests). */
const FALLBACK_CHAR_WIDTH = 6.6;
const GHOST_LABEL = '…';

// Must match `.box` / `.box-root` in graph.css. Measured at the bold weight of `.box-current`,
// so a label still fits once its node becomes current.
const LABEL_FONT = '600 10.8px "Source Serif 4 Variable", Georgia, serif';
const ROOT_FONT = '650 11.2px "Source Serif 4 Variable", Georgia, serif';

/** Resolves once the label fonts are loaded, so boxes can be measured with real metrics. */
export function loadLabelFonts(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  return Promise.all([document.fonts.load(LABEL_FONT), document.fonts.load(ROOT_FONT)]);
}

let context: CanvasRenderingContext2D | null | undefined;

function textWidth(label: string, isRoot: boolean): number {
  if (context === undefined) {
    context =
      typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!context) return label.length * FALLBACK_CHAR_WIDTH * (isRoot ? 1.08 : 1);
  context.font = isRoot ? ROOT_FONT : LABEL_FONT;
  return context.measureText(label).width;
}

/** Box size that fits the whole label; long labels wrap onto up to three lines. */
function sizeOf(label: string, isRoot: boolean): { width: number; height: number } {
  // A little slack for sub-pixel rounding and the border.
  const text = Math.ceil(textWidth(label, isRoot)) + 4;
  const minWidth = isRoot ? 88 : 64;
  const inner = MAX_WIDTH - PAD_X;
  const lines = Math.min(MAX_LINES, Math.max(1, Math.ceil(text / inner)));
  const width = lines === 1 ? Math.max(minWidth, text + PAD_X) : MAX_WIDTH;
  return { width, height: lines * LINE_HEIGHT + PAD_Y };
}

/**
 * Top-down tree layout. Positions are node top-left corners, as React Flow expects.
 * `ghostParent` (a node id, `''` for the root) gets a placeholder last child: new answers are
 * sorted by `created`, so that is where the next node will appear.
 */
export function layoutTree(
  title: string,
  nodes: HierarchyNode[],
  ghostParent: string | null = null,
): { nodes: BoxNode[]; edges: TreeEdgeType[] } {
  const graph = new Graph();
  graph.setGraph({ rankdir: 'TB', nodesep: 20, ranksep: 42, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));

  const boxes: {
    id: string;
    label: string;
    isRoot: boolean;
    childCount: number;
    depth: number;
    ghost?: boolean;
  }[] = [];
  const edges: TreeEdgeType[] = [];

  const addGhost = (parentFlowId: string, depth: number) => {
    const id = ghostKey(parentFlowId);
    boxes.push({ id, label: GHOST_LABEL, isRoot: false, childCount: 0, depth, ghost: true });
    edges.push({
      id: `edge:${id}`,
      type: 'tree',
      source: parentFlowId,
      target: id,
      data: { depth },
    });
  };

  const visit = (list: HierarchyNode[], parentFlowId: string, depth: number) => {
    for (const node of list) {
      boxes.push({
        id: node.id,
        label: node.name,
        isRoot: false,
        childCount: node.children.length,
        depth,
      });
      edges.push({
        // Keyed by child only: a move keeps the edge mounted instead of redrawing it.
        id: `edge:${node.id}`,
        type: 'tree',
        source: parentFlowId,
        target: node.id,
        data: { depth },
      });
      visit(node.children, node.id, depth + 1);
    }
    if (ghostParent !== null && parentFlowId === toFlowId(ghostParent))
      addGhost(parentFlowId, depth);
  };
  boxes.push({ id: ROOT_KEY, label: title, isRoot: true, childCount: nodes.length, depth: 0 });
  visit(nodes, ROOT_KEY, 1);

  for (const box of boxes) {
    graph.setNode(box.id, sizeOf(box.label, box.isRoot));
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
        draggable: !box.isRoot && !box.ghost,
        selectable: !box.ghost,
        data: {
          nodeId: box.ghost ? '' : fromFlowId(box.id),
          label: box.label,
          isRoot: box.isRoot,
          childCount: box.childCount,
          current: false,
          inChain: false,
          selected: false,
          dropTarget: false,
          busy: false,
          ghost: box.ghost ?? false,
          depth: box.depth,
        },
      };
    }),
    edges,
  };
}
