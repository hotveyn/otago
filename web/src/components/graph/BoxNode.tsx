import { Handle, type NodeProps, Position } from '@xyflow/react';
import { type CSSProperties, memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoxNode as BoxNodeType } from './layout';

const handles = {
  target: (
    <Handle type="target" position={Position.Top} className="box-handle" isConnectable={false} />
  ),
  source: (
    <Handle type="source" position={Position.Bottom} className="box-handle" isConnectable={false} />
  ),
};

/** An in-flight question: one-line label inside a marching dashed ring. */
function PendingBox({ data, width = 0, height = 0 }: NodeProps<BoxNodeType>) {
  const { t } = useTranslation('graph');
  const status = data.pendingStatus ?? 'streaming';
  const classes = [
    'box',
    'box-pending',
    `box-pending-${status}`,
    data.focus ? 'box-focus' : '',
    data.open ? 'box-open' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={classes}
      style={{ '--depth': data.depth } as CSSProperties}
      title={data.tooltip}
    >
      {handles.target}
      <svg className="box-ring" aria-hidden="true" width={width} height={height}>
        <rect
          x={0.5}
          y={0.5}
          width={Math.max(0, width - 1)}
          height={Math.max(0, height - 1)}
          rx={2.4}
        />
      </svg>
      {status === 'failed' && (
        <span className="box-glyph" aria-hidden="true">
          !
        </span>
      )}
      <span className="box-label" dir="auto">
        {data.label}
      </span>
      {data.escArmed && <span className="box-hint">{t('pending.escAgain')}</span>}
      {handles.source}
    </div>
  );
}

export const BoxNode = memo(function BoxNode(props: NodeProps<BoxNodeType>) {
  const { t } = useTranslation('graph');
  const { data } = props;
  if (data.pendingKey !== null) return <PendingBox {...props} />;
  const classes = [
    'box',
    data.isRoot ? 'box-root' : '',
    data.current ? 'box-current' : '',
    data.inChain ? 'box-chain' : '',
    data.selected ? 'box-selected' : '',
    data.dropTarget ? 'box-drop' : '',
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
      {handles.target}
      <span className="box-label" dir="auto">
        {data.label}
      </span>
      {handles.source}
    </div>
  );
});
