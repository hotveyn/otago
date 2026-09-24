import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  applyNodeChanges,
  Controls,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { afterDelete, afterMove, canMoveTo, chainIds, flatten, topLevelIds } from '../../lib/tree';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { BoxNode as BoxNodeComponent } from './BoxNode';
import { type BoxNode, fromFlowId, layoutTree } from './layout';
import { DeleteDialog, MoveDialog } from './NodeDialogs';

const nodeTypes = { box: BoxNodeComponent };

/** Below this zoom labels get hard to read, so big trees focus on one area instead of fitting. */
const READABLE_ZOOM = 0.6;
const FOCUS_ZOOM = 0.9;

const centerOf = (node: BoxNode): [number, number] => [
  node.position.x + (node.width ?? 0) / 2,
  node.position.y + (node.height ?? 0) / 2,
];

interface GraphViewProps {
  tree: TreeDetail;
  currentId: string;
  busy: boolean;
  onSelectNode: (id: string) => void;
  /** Current node changed because of a delete/move; replaces the history entry. */
  onCurrentChange: (id: string) => void;
}

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}

function Graph({ tree, currentId, busy, onSelectNode, onCurrentChange }: GraphViewProps) {
  const queryClient = useQueryClient();
  const flow = useReactFlow<BoxNode>();
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'delete' | 'move' | null>(null);

  const layout = useMemo(() => layoutTree(tree.title, tree.nodes), [tree.title, tree.nodes]);
  const known = useMemo(
    () => new Set(flatten(tree.nodes).map(({ node }) => node.id)),
    [tree.nodes],
  );

  // Forget selected ids that no longer exist.
  useEffect(() => {
    setSelection((current) => {
      const next = new Set([...current].filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [known]);

  const chain = useMemo(() => new Set(chainIds(currentId)), [currentId]);
  const decorate = useCallback(
    (nodes: BoxNode[]): BoxNode[] =>
      nodes.map((node) => {
        const id = node.data.nodeId;
        const data = {
          ...node.data,
          current: id === currentId,
          inChain: node.data.isRoot || chain.has(id),
          selected: selection.has(id),
          dropTarget: node.id === dropTarget,
        };
        const same =
          data.current === node.data.current &&
          data.inChain === node.data.inChain &&
          data.selected === node.data.selected &&
          data.dropTarget === node.data.dropTarget;
        return same ? node : { ...node, data };
      }),
    [currentId, chain, selection, dropTarget],
  );

  const [nodes, setNodes] = useState<BoxNode[]>(() => decorate(layout.nodes));
  // New hierarchy → fresh positions; decoration changes are handled by the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the layout changes
  useEffect(() => setNodes(decorate(layout.nodes)), [layout]);
  useEffect(() => setNodes((current) => decorate(current)), [decorate]);

  const edges = useMemo(
    () =>
      layout.edges.map((edge) => ({
        ...edge,
        type: 'smoothstep',
        className: chain.has(fromFlowId(edge.target)) ? 'edge-chain' : undefined,
      })),
    [layout.edges, chain],
  );

  const pane = useRef<HTMLDivElement>(null);
  const boxOf = (id: string) => layout.nodes.find((node) => node.data.nodeId === id);

  // On tree switch: fit small trees; for big ones keep a readable zoom around the current node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on tree switch
  useEffect(() => {
    const frame = requestAnimationFrame(async () => {
      await flow.fitView({ padding: 0.2, maxZoom: 1.1 });
      if (flow.getZoom() >= READABLE_ZOOM) return;
      const target = boxOf(currentId) ?? boxOf('');
      const height = pane.current?.clientHeight ?? 0;
      if (!target) return;
      const [cx, cy] = centerOf(target);
      // Keep the top of the tree in view instead of leaving empty space above it.
      await flow.setCenter(cx, Math.max(cy, height / 2 / FOCUS_ZOOM - 20), { zoom: FOCUS_ZOOM });
    });
    return () => cancelAnimationFrame(frame);
  }, [tree.id]);

  // Pan to the current node when it is off screen (e.g. a freshly created answer).
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to the current node only
  useEffect(() => {
    const target = boxOf(currentId);
    const rect = pane.current?.getBoundingClientRect();
    if (!target || !rect) return;
    const { x, y, zoom } = flow.getViewport();
    const [cx, cy] = centerOf(target);
    const sx = cx * zoom + x;
    const sy = cy * zoom + y;
    const margin = 60;
    if (sx < margin || sy < margin || sx > rect.width - margin || sy > rect.height - margin) {
      void flow.setCenter(cx, cy, { zoom, duration: 300 });
    }
  }, [currentId, layout]);

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const applyHierarchy = (nodesAfter: TreeDetail['nodes']) => {
    queryClient.setQueryData<TreeDetail>(keys.tree(tree.id), (old) =>
      old ? { ...old, nodes: nodesAfter } : old,
    );
    queryClient.removeQueries({ queryKey: ['chain', tree.id] });
  };

  const remove = useMutation({
    mutationFn: (ids: string[]) => api.deleteNodes(tree.id, ids),
    onSuccess: (nodesAfter, ids) => {
      applyHierarchy(nodesAfter);
      setSelection(new Set());
      setDialog(null);
      onCurrentChange(afterDelete(currentId, ids));
    },
  });

  const move = useMutation({
    mutationFn: ({ ids, target }: { ids: string[]; target: string }) =>
      api.moveNodes(tree.id, ids, target),
    onSuccess: (result) => {
      applyHierarchy(result.nodes);
      setSelection(new Set());
      setDialog(null);
      onCurrentChange(afterMove(currentId, result.moved));
    },
    onError: () => setNodes(decorate(layout.nodes)),
  });

  const actionError = remove.error ?? move.error;
  const resetErrors = () => {
    remove.reset();
    move.reset();
  };
  const openDialog = (kind: 'delete' | 'move') => {
    resetErrors();
    setDialog(kind);
  };

  const onNodeClick: NodeMouseHandler<BoxNode> = (event, node) => {
    const id = node.data.nodeId;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      if (node.data.isRoot) return;
      setSelection((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelection(new Set());
    onSelectNode(id);
  };

  const dragIds = (node: BoxNode) =>
    selection.has(node.data.nodeId) ? [...selection] : [node.data.nodeId];

  const findDropTarget = (node: BoxNode): BoxNode | undefined => {
    const ids = dragIds(node);
    return flow
      .getIntersectingNodes(node)
      .map((hit) => hit as BoxNode)
      .find(
        (hit) =>
          hit.id !== node.id && canMoveTo(ids, hit.data.nodeId) && !ids.includes(hit.data.nodeId),
      );
  };

  const onNodeDrag: OnNodeDrag<BoxNode> = (_event, node) => {
    setDropTarget(findDropTarget(node)?.id ?? null);
  };

  const onNodeDragStop: OnNodeDrag<BoxNode> = (_event, node) => {
    const target = findDropTarget(node);
    setDropTarget(null);
    setNodes(decorate(layout.nodes));
    if (!target || busy) return;
    resetErrors();
    move.mutate({ ids: dragIds(node), target: target.data.nodeId });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog === null) setSelection(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  const selected = [...selection];
  const topSelected = topLevelIds(selected);

  return (
    <div className="graph" ref={pane}>
      <div className="graph-toolbar">
        {selection.size > 0 ? (
          <>
            <span className="selection-count">
              {topSelected.length} selected
              {topSelected.length !== selection.size && (
                <span className="muted"> ({selection.size - topSelected.length} inside)</span>
              )}
            </span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => openDialog('delete')}>
              Delete
            </Button>
            <Button size="sm" disabled={busy} onClick={() => openDialog('move')}>
              Move to…
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>
              Clear
            </Button>
          </>
        ) : (
          <span className="muted small">
            Click to open · Shift/⌘-click to select · drag onto a node to move
          </span>
        )}
        {busy && <span className="muted small">Answering… changes are paused</span>}
      </div>
      {actionError && dialog === null && (
        <div className="graph-error">
          <ErrorNote error={actionError} onDismiss={resetErrors} />
        </div>
      )}

      <ReactFlow<BoxNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => setSelection(new Set())}
        nodesDraggable={!busy}
        nodesConnectable={false}
        elementsSelectable={false}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
      >
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>

      <DeleteDialog
        open={dialog === 'delete'}
        nodes={tree.nodes}
        selection={selected}
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(selected)}
        onClose={() => setDialog(null)}
      />
      <MoveDialog
        open={dialog === 'move'}
        title={tree.title}
        nodes={tree.nodes}
        selection={selected}
        pending={move.isPending}
        error={move.error}
        onConfirm={(target) => move.mutate({ ids: selected, target })}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
