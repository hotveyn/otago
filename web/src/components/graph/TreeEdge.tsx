import { BaseEdge, type Edge, type EdgeProps } from '@xyflow/react';
import { type CSSProperties, memo } from 'react';

const RADIUS = 6;

/**
 * Org-chart connector: straight down from the parent, across on a bus shared by all
 * siblings (halfway between the ranks), then straight down into the child.
 */
export function treePath(sx: number, sy: number, tx: number, ty: number): string {
  const midY = sy + (ty - sy) / 2;
  const dx = tx - sx;
  if (Math.abs(dx) < 1) return `M ${sx},${sy} V ${ty}`;
  const r = Math.min(RADIUS, Math.abs(dx) / 2, (ty - sy) / 2);
  const dir = Math.sign(dx);
  return [
    `M ${sx},${sy}`,
    `V ${midY - r}`,
    `Q ${sx},${midY} ${sx + dir * r},${midY}`,
    `H ${tx - dir * r}`,
    `Q ${tx},${midY} ${tx},${midY + r}`,
    `V ${ty}`,
  ].join(' ');
}

export type TreeEdgeType = Edge<{ depth: number }, 'tree'>;

export const TreeEdge = memo(function TreeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  style,
  markerEnd,
}: EdgeProps<TreeEdgeType>) {
  return (
    <BaseEdge
      id={id}
      path={treePath(sourceX, sourceY, targetX, targetY)}
      style={{ ...style, '--depth': data?.depth ?? 0 } as CSSProperties}
      markerEnd={markerEnd}
    />
  );
});
