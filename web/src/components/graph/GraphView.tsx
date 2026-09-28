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
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { describeError } from '../../lib/chat-errors';
import { renameTargetOf } from '../../lib/rename';
import {
  afterDelete,
  afterMove,
  canMoveTo,
  chainIds,
  findNode,
  flatten,
  nameOf,
  topLevelIds,
} from '../../lib/tree';
import type { AppliedStep } from '../../lib/undo-history';
import { Button } from '../ui/Button';
import { ErrorNote } from '../ui/ErrorNote';
import { BoxNode as BoxNodeComponent } from './BoxNode';
import {
  type BoxNode,
  fromFlowId,
  ghostKey,
  isGhostKey,
  layoutTree,
  loadLabelFonts,
} from './layout';
import { DeleteDialog, MoveDialog, RenameDialog } from './NodeDialogs';
import { TreeEdge } from './TreeEdge';
import { useTreeUndo } from './useTreeUndo';

const nodeTypes = { box: BoxNodeComponent };
const edgeTypes = { tree: TreeEdge };

/** How long boxes glide to their new place after the hierarchy changes. */
const MOVE_MS = 380;

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Bumps once the label fonts load, so the layout re-measures with real glyph widths. */
function useFontsVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    loadLabelFonts()
      .catch(() => undefined)
      .then(() => alive && setVersion((v) => v + 1));
    return () => {
      alive = false;
    };
  }, []);
  return version;
}

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
  /** Current node changed because of a delete/move/rename; replaces the history entry. */
  onCurrentChange: (id: string) => void;
  /** Nodes were moved, renamed or deleted (after the hierarchy cache is updated). */
  onNodesChanged?: (change: NodesChange) => void;
}

export type NodesChange =
  | { kind: 'move'; moved: Record<string, string> }
  | { kind: 'delete'; ids: string[] }
  /** `renamed` = full old → new id map (the renamed node and every descendant). */
  | { kind: 'rename'; renamed: Record<string, string> };

export function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}

function Graph({
  tree,
  currentId,
  busy,
  onSelectNode,
  onCurrentChange,
  onNodesChanged,
}: GraphViewProps) {
  const { t } = useTranslation(['graph', 'common']);
  const queryClient = useQueryClient();
  const flow = useReactFlow<BoxNode>();
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'delete' | 'move' | 'rename' | null>(null);
  /** Rename target, frozen when the dialog opens. */
  const [renameId, setRenameId] = useState('');

  const fontsVersion = useFontsVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure once fonts load
  const layout = useMemo(
    () => layoutTree(tree.title, tree.nodes, currentId),
    [tree.title, tree.nodes, currentId, fontsVersion],
  );
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
        if (node.data.ghost) return node;
        const id = node.data.nodeId;
        const data = {
          ...node.data,
          current: id === currentId,
          inChain: node.data.isRoot || chain.has(id),
          selected: selection.has(id),
          dropTarget: node.id === dropTarget,
          busy,
        };
        const same =
          data.current === node.data.current &&
          data.inChain === node.data.inChain &&
          data.selected === node.data.selected &&
          data.dropTarget === node.data.dropTarget &&
          data.busy === node.data.busy;
        return same ? node : { ...node, data };
      }),
    [currentId, chain, selection, dropTarget, busy],
  );

  const [nodes, setNodes] = useState<BoxNode[]>(() => decorate(layout.nodes));
  const nodesRef = useRef(nodes);
  const decorateRef = useRef(decorate);
  useEffect(() => {
    nodesRef.current = nodes;
    decorateRef.current = decorate;
  });

  // When nodes are added (e.g. a new answer), glide everything to the new layout and grow the
  // new boxes out of their parent. Moves, deletes and drops snap into place instantly.
  const frame = useRef(0);
  const animateTo = useCallback(
    (target: BoxNode[]) => {
      cancelAnimationFrame(frame.current);
      const from = new Map(nodesRef.current.map((node) => [node.id, node.position]));
      const parentOf = new Map(layout.edges.map((edge) => [edge.target, edge.source]));
      const shared = target.some((node) => from.has(node.id));
      const added = target.some((node) => !from.has(node.id));
      if (!shared || !added || prefersReducedMotion()) {
        setNodes(decorateRef.current(target));
        return;
      }
      const startOf = (node: BoxNode) => {
        const own = from.get(node.id);
        if (own) return own;
        // A new answer takes the place of the placeholder that stood under its parent.
        const ghost = from.get(ghostKey(parentOf.get(node.id) ?? ''));
        if (ghost && !node.data.ghost) return ghost;
        const parent = target.find((other) => other.id === parentOf.get(node.id));
        const origin = parent && from.get(parent.id);
        if (!parent || !origin) return node.position;
        // Centre the new box under the parent's old spot.
        return {
          x: origin.x + ((parent.width ?? 0) - (node.width ?? 0)) / 2,
          y: origin.y + (parent.height ?? 0),
        };
      };
      const moves = target.map((node) => ({ node, a: startOf(node) }));
      const began = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - began) / MOVE_MS);
        const k = 1 - (1 - t) ** 3;
        const frameNodes = moves.map(({ node, a }) => {
          if (t === 1 || (a.x === node.position.x && a.y === node.position.y)) return node;
          return {
            ...node,
            position: {
              x: a.x + (node.position.x - a.x) * k,
              y: a.y + (node.position.y - a.y) * k,
            },
          };
        });
        setNodes(decorateRef.current(frameNodes));
        if (t < 1) frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    },
    [layout.edges],
  );
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // New hierarchy → animate to fresh positions; decoration changes are handled below.
  useEffect(() => animateTo(layout.nodes), [animateTo, layout.nodes]);
  useEffect(() => setNodes((current) => decorate(current)), [decorate]);

  const edges = useMemo(
    () =>
      layout.edges.map((edge) => {
        if (isGhostKey(edge.target)) return { ...edge, className: 'edge-ghost' };
        const inChain = chain.has(fromFlowId(edge.target));
        // Chain edges sit above the grey ones where sibling buses overlap, with marching dashes.
        return {
          ...edge,
          className: inChain ? 'edge-chain' : undefined,
          animated: inChain,
          zIndex: inChain ? 1 : 0,
        };
      }),
    [layout.edges, chain],
  );

  const pane = useRef<HTMLDivElement>(null);
  const boxOf = (id: string) =>
    layout.nodes.find((node) => !node.data.ghost && node.data.nodeId === id);

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

  const applyHierarchy = (nodesAfter: TreeDetail['nodes'], treeId = tree.id) => {
    queryClient.setQueryData<TreeDetail>(keys.tree(treeId), (old) =>
      old ? { ...old, nodes: nodesAfter } : old,
    );
    queryClient.removeQueries({ queryKey: ['chain', treeId] });
  };

  // Latest values for the undo callback, which may resolve after a re-render or tree switch.
  const live = useRef({ treeId: tree.id, currentId, onCurrentChange, onNodesChanged });
  useEffect(() => {
    live.current = { treeId: tree.id, currentId, onCurrentChange, onNodesChanged };
  });

  const onUndoApplied = (treeId: string, { nodes: nodesAfter, fixups, kind }: AppliedStep) => {
    applyHierarchy(nodesAfter, treeId);
    const now = live.current;
    if (treeId !== now.treeId || Object.keys(fixups).length === 0) return;
    // The current node is never inside the trash, so only an undone move can carry it along.
    if (kind === 'move') {
      const next = afterMove(now.currentId, fixups);
      if (next !== now.currentId) now.onCurrentChange(next);
    }
    now.onNodesChanged?.({ kind: 'move', moved: fixups });
  };

  const remove = useMutation({
    mutationFn: (ids: string[]) => api.deleteNodes(tree.id, ids),
    onSuccess: (result, ids) => {
      applyHierarchy(result.nodes);
      setSelection(new Set());
      setDialog(null);
      onCurrentChange(afterDelete(currentId, ids));
      onNodesChanged?.({ kind: 'delete', ids });
      undo.recordDelete(result.deleted);
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
      onNodesChanged?.({ kind: 'move', moved: result.moved });
      undo.recordMove(result.moved);
    },
    onError: () => animateTo(layout.nodes),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameNode(tree.id, id, name),
    onSuccess: (result) => {
      applyHierarchy(result.nodes);
      setSelection(new Set());
      setDialog(null);
      const next = afterMove(currentId, result.renamed);
      if (next !== currentId) onCurrentChange(next);
      onNodesChanged?.({ kind: 'rename', renamed: result.renamed });
      undo.remap(result.renamed);
    },
  });

  const undo = useTreeUndo({
    treeId: tree.id,
    streaming: busy,
    blocked: dialog !== null || remove.isPending || move.isPending || rename.isPending,
    onApplied: onUndoApplied,
  });
  /** Structural edits are paused while an answer streams or an undo runs. */
  const frozen = busy || undo.pending;

  const actionError = remove.error ?? move.error ?? rename.error;
  const resetErrors = () => {
    remove.reset();
    move.reset();
    rename.reset();
  };
  const openDialog = (kind: 'delete' | 'move') => {
    resetErrors();
    setDialog(kind);
  };
  const renameTarget = renameTargetOf(selection, currentId);
  const openRename = (target: string) => {
    resetErrors();
    setRenameId(target);
    setDialog('rename');
  };

  const onNodeClick: NodeMouseHandler<BoxNode> = (event, node) => {
    if (node.data.ghost) return;
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
          hit.id !== node.id &&
          !hit.data.ghost &&
          canMoveTo(ids, hit.data.nodeId) &&
          !ids.includes(hit.data.nodeId),
      );
  };

  const onNodeDrag: OnNodeDrag<BoxNode> = (_event, node) => {
    setDropTarget(findDropTarget(node)?.id ?? null);
  };

  const onNodeDragStop: OnNodeDrag<BoxNode> = (_event, node) => {
    const target = findDropTarget(node);
    setDropTarget(null);
    animateTo(layout.nodes);
    if (!target || frozen) return;
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
              {t('selected', { count: topSelected.length })}
              {topSelected.length !== selection.size && (
                <span className="muted">
                  {' '}
                  {t('inside', { count: selection.size - topSelected.length })}
                </span>
              )}
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={frozen}
              onClick={() => openDialog('delete')}
            >
              {t('common:delete')}
            </Button>
            <Button size="sm" disabled={frozen} onClick={() => openDialog('move')}>
              {t('moveTo')}
            </Button>
            {renameTarget !== null && (
              <Button size="sm" disabled={frozen} onClick={() => openRename(renameTarget)}>
                {t('rename')}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>
              {t('clear')}
            </Button>
          </>
        ) : (
          <>
            <span className="muted small">{t('hint')}</span>
            {renameTarget !== null && (
              <Button
                size="sm"
                variant="ghost"
                disabled={frozen}
                onClick={() => openRename(renameTarget)}
              >
                {t('rename')}
              </Button>
            )}
          </>
        )}
        {busy && <span className="muted small">{t('busy')}</span>}
      </div>
      {actionError && dialog === null ? (
        <div className="graph-error">
          <ErrorNote
            error={actionError}
            message={describeError(actionError).message}
            onDismiss={resetErrors}
          />
        </div>
      ) : (
        undo.toast && (
          <div className="graph-error">
            <ErrorNote
              key={undo.toast.key}
              error={undo.toast.message}
              onDismiss={undo.dismissToast}
            />
          </div>
        )
      )}

      <ReactFlow<BoxNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onPaneClick={() => setSelection(new Set())}
        nodesDraggable={!frozen}
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
      <RenameDialog
        open={dialog === 'rename'}
        currentName={findNode(tree.nodes, renameId)?.name ?? nameOf(renameId)}
        pending={rename.isPending}
        error={rename.error}
        onConfirm={(name) => rename.mutate({ id: renameId, name })}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
