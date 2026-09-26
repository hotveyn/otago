import { Handle, type NodeProps, Position } from '@xyflow/react';
import { type CSSProperties, memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoxNode as BoxNodeType } from './layout';

export const BoxNode = memo(function BoxNode({ data }: NodeProps<BoxNodeType>) {
  const { t } = useTranslation('graph');
  const classes = [
    'box',
    data.isRoot ? 'box-root' : '',
    data.current ? 'box-current' : '',
    data.inChain ? 'box-chain' : '',
    data.selected ? 'box-selected' : '',
    data.dropTarget ? 'box-drop' : '',
    data.busy && data.current ? 'box-busy' : '',
    data.ghost ? 'box-ghost' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      style={{ '--depth': data.depth } as CSSProperties}
      title={data.ghost ? t('ghostTitle') : data.isRoot ? t('rootTitle') : data.nodeId}
    >
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
