import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import type { BoxNode as BoxNodeType } from './layout';

export const BoxNode = memo(function BoxNode({ data }: NodeProps<BoxNodeType>) {
  const classes = [
    'box',
    data.isRoot ? 'box-root' : '',
    data.current ? 'box-current' : '',
    data.inChain ? 'box-chain' : '',
    data.selected ? 'box-selected' : '',
    data.dropTarget ? 'box-drop' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} title={data.isRoot ? 'Tree root' : data.nodeId}>
      <Handle type="target" position={Position.Top} className="box-handle" isConnectable={false} />
      <span className="box-label">{data.label}</span>
      <Handle
        type="source"
        position={Position.Bottom}
        className="box-handle"
        isConnectable={false}
      />
    </div>
  );
});
