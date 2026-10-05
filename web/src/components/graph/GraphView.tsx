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
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { keys } from '../../api/queries';
import type { TreeDetail } from '../../api/types';
import { treeBusyDetailsOf } from '../../lib/blockers';
import { describeError } from '../../lib/chat-errors';
import { pushNotice } from '../../lib/notices';
import {
  useConnectionStatus,
  usePendingBoxes,
  usePendingStatuses,
  useQuestionStore,
  useTreeBusy,
  useTreeCounts,
} from '../../lib/question-store';
import type { ConnectionStatus, PendingStatusInfo } from '../../lib/questions';
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
import { useShowBlockers } from './blockers-context';
import {
  type BoxNode,
  fromFlowId,
  ghostKey,
  isGhostKey,
  isPendingFlowId,
  layoutTree,
  loadLabelFonts,
  PENDING_PREFIX,
  pendingFlowId,
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

/** How long the first Esc on a running pending box stays armed. */
const ESC_ARM_MS = 2_000;
/** "Reconnecting…" shows only after this long (short blips stay silent). */
const RECONNECTING_NOTICE_MS = 3_000;

const CANCELLABLE: ReadonlySet<string> = new Set(['sending', 'uploading', 'streaming']);

/** True once the event stream has been reconnecting for a while after having been live. */
function useReconnecting(status: ConnectionStatus): boolean {
  const [shown, setShown] = useState(false);
  const wasLive = useRef(false);
  useEffect(() => {
    if (status === 'live') wasLive.current = true;
    if (status !== 'reconnecting' || !wasLive.current) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), RECONNECTING_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [status]);
  return shown;
}

interface GraphViewProps {
  tree: TreeDetail;
  currentId: string;
  /** In-flight questions the panels show: main chat (`q`) and foreground aside (`sideQ`). */
  focus: { main: string | null; side: string | null };
  onSelectNode: (id: string) => void;
  /** Current node changed because of a delete/move/rename; replaces the history entry. */
  onCurrentChange: (id: string) => void;
  /** Nodes were moved, renamed, deleted or restored (after the hierarchy cache is updated). */
  onNodesChanged?: (change: NodesChange) => void;
  /** A pending box was clicked (or Enter on it): open its question. */
  onOpenPending: (key: string) => void;
}

export type NodesChange =
  | { kind: 'move'; moved: Record<string, string> }
  | { kind: 'delete'; ids: string[] }
  /** `renamed` = full old → new id map (the renamed node and every descendant). */
  | { kind: 'rename'; renamed: Record<string, string> }
  /** An undone delete: original id → restored id for nodes that came back as `-2`. */
  | { kind: 'restore'; restored: Record<string, string> };

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
  focus,
  onSelectNode,
  onCurrentChange,
  onNodesChanged,
  onOpenPending,
}: GraphViewProps) {
  const { t } = useTranslation(['graph', 'common']);
  const queryClient = useQueryClient();
  const flow = useReactFlow<BoxNode>();
  const store = useQuestionStore();
  const showBlockers = useShowBlockers();
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'delete' | 'move' | 'rename' | null>(null);
  /** Rename target, frozen when the dialog opens. */
  const [renameId, setRenameId] = useState('');
  /** Pending box key whose first Esc was pressed. */
  const [escArmed, setEscArmed] = useState<string | null>(null);

  // The graph never subscribes to stream text: boxes change on add/remove/remap/label only,
  // statuses on status changes only.
  const busy = useTreeBusy(tree.id);
  const boxes = usePendingBoxes(tree.id);
  const statuses = usePendingStatuses(tree.id);
  const runningCount = useTreeCounts()[tree.id]?.running ?? 0;
  const reconnecting = useReconnecting(useConnectionStatus());

  const known = useMemo(
    () => new Set(flatten(tree.nodes).map(({ node }) => node.id)),
    [tree.nodes],
  );
  // A saved answer keeps its box until the refetched tree shows its node (no empty frame).
  const visibleBoxes = useMemo(
    () => boxes.filter((box) => !(box.nodeId && known.has(box.nodeId))),
    [boxes, known],
  );
  const boxByKey = useMemo(() => new Map(boxes.map((box) => [box.key, box])), [boxes]);
  /** Key of the pending box the main chat shows: its question, or its send under `currentId`. */
  const focusKey = useMemo(() => {
    const box =
      focus.main !== null
        ? boxes.find((item) => item.questionId === focus.main)
        : boxes.find(
            (item) =>
              item.outboxId !== null && item.context.kind === 'main' && item.parentId === currentId,
          );
    return box?.key ?? null;
  }, [boxes, focus.main, currentId]);
  // The focused box stands where the next answer goes: no ghost then.
  const ghostParent = focus.main !== null || focusKey !== null ? null : currentId;

  const fontsVersion = useFontsVersion();
  // Relayout only on hierarchy, ghost or box changes; never on a chunk or a status change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure once fonts load
  const layout = useMemo(
    () => layoutTree(tree.title, tree.nodes, ghostParent, visibleBoxes),
    [tree.title, tree.nodes, ghostParent, visibleBoxes, fontsVersion],
  );

  // Forget selected ids that no longer exist.
  useEffect(() => {
    setSelection((current) => {
      const next = new Set([...current].filter((id) => known.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [known]);

  const chain = useMemo(() => new Set(chainIds(currentId)), [currentId]);
  const tooltipOf = useCallback(
    (status: PendingStatusInfo | undefined): string => {
      if (!status) return '';
      const label =
        status.status === 'failed'
          ? t('pending.failed', { message: status.error ?? '' })
          : t(`pending.${status.status}`);
      return `${status.tooltip}\n${label} · ${t('pending.hint')}`;
    },
    [t],
  );
  const decorate = useCallback(
    (nodes: BoxNode[]): BoxNode[] =>
      nodes.map((node) => {
        if (node.data.ghost) return node;
        const key = node.data.pendingKey;
        if (key !== null) {
          const status = statuses[key];
          const box = boxByKey.get(key);
          const questionId = box?.questionId ?? null;
          const data = {
            ...node.data,
            pendingStatus: status?.status ?? null,
            focus: key === focusKey,
            open: questionId !== null && questionId === focus.side,
            escArmed: escArmed === key,
            tooltip: tooltipOf(status),
          };
          const same =
            data.pendingStatus === node.data.pendingStatus &&
            data.focus === node.data.focus &&
            data.open === node.data.open &&
            data.escArmed === node.data.escArmed &&
            data.tooltip === node.data.tooltip;
          return same ? node : { ...node, data };
        }
        const id = node.data.nodeId;
        const data = {
          ...node.data,
          // While the main chat shows a question, its box is the focus, not the parent.
          current: id === currentId && focus.main === null,
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
    [
      currentId,
      chain,
      selection,
      dropTarget,
      statuses,
      boxByKey,
      focusKey,
      focus.main,
      focus.side,
      escArmed,
      tooltipOf,
    ],
  );

  const [nodes, setNodes] = useState<BoxNode[]>(() => decorate(layout.nodes));
  const nodesRef = useRef(nodes);
  const decorateRef = useRef(decorate);
  /** Created node id → flow id of the pending box it replaces. */
  const doneBoxesRef = useRef(new Map<string, string>());
  useEffect(() => {
    nodesRef.current = nodes;
    decorateRef.current = decorate;
    doneBoxesRef.current = new Map(
      boxes.flatMap((box) => (box.nodeId ? [[box.nodeId, pendingFlowId(box.key)] as const] : [])),
    );
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
        // A saved answer takes the place of its pending box.
        const pendingBox = doneBoxesRef.current.get(node.id);
        const pendingStart = pendingBox === undefined ? undefined : from.get(pendingBox);
        if (pendingStart) return pendingStart;
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
        if (isPendingFlowId(edge.target)) {
          const key = edge.target.slice(PENDING_PREFIX.length);
          if (key === focusKey)
            return { ...edge, className: 'edge-chain', animated: true, zIndex: 1 };
          const failed = statuses[key]?.status === 'failed';
          return { ...edge, className: failed ? 'edge-failed' : 'edge-pending', zIndex: 0 };
        }
        const inChain = chain.has(fromFlowId(edge.target));
        // Chain edges sit above the grey ones where sibling buses overlap, with marching dashes.
        return {
          ...edge,
          className: inChain ? 'edge-chain' : undefined,
          animated: inChain,
          zIndex: inChain ? 1 : 0,
        };
      }),
    [layout.edges, chain, statuses, focusKey],
  );

  const pane = useRef<HTMLDivElement>(null);
  const boxOf = (id: string) =>
    layout.nodes.find(
      (node) => !node.data.ghost && node.data.pendingKey === null && node.data.nodeId === id,
    );
  /** The focused pending box when the main chat shows a question, else the current node. */
  const focusBoxOf = () =>
    (focusKey !== null && focus.main !== null
      ? layout.nodes.find((node) => node.id === pendingFlowId(focusKey))
      : undefined) ?? boxOf(currentId);

  // On tree switch: fit small trees; for big ones keep a readable zoom around the current node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on tree switch
  useEffect(() => {
    const frame = requestAnimationFrame(async () => {
      await flow.fitView({ padding: 0.2, maxZoom: 1.1 });
      if (flow.getZoom() >= READABLE_ZOOM) return;
      const target = focusBoxOf() ?? boxOf('');
      const height = pane.current?.clientHeight ?? 0;
      if (!target) return;
      const [cx, cy] = centerOf(target);
      // Keep the top of the tree in view instead of leaving empty space above it.
      await flow.setCenter(cx, Math.max(cy, height / 2 / FOCUS_ZOOM - 20), { zoom: FOCUS_ZOOM });
    });
    return () => cancelAnimationFrame(frame);
  }, [tree.id]);

  // Pan to the current node (or focused pending box) when it is off screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to the current node only
  useEffect(() => {
    const target = focusBoxOf();
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
  }, [currentId, focusKey, layout]);

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
      now.onNodesChanged?.({ kind: 'move', moved: fixups });
    } else now.onNodesChanged?.({ kind: 'restore', restored: fixups });
  };

  /**
   * A 409 `tree_busy_streaming`: close the form and open the blockers dialog, which offers the
   * same action again once nothing blocks it. Other errors stay inline.
   */
  const onBusyError = (error: unknown, label: string, run: () => void) => {
    if (!treeBusyDetailsOf(error)) return;
    setDialog(null);
    showBlockers({ tree: tree.id, error, retry: { label, run } });
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
    onError: (error, ids) =>
      onBusyError(error, t('blockers.retry.delete'), () => remove.mutate(ids)),
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
    onError: (error, variables) => {
      animateTo(layout.nodes);
      onBusyError(error, t('blockers.retry.move'), () => move.mutate(variables));
    },
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
    onError: (error, variables) =>
      onBusyError(error, t('blockers.retry.rename'), () => rename.mutate(variables)),
  });

  const undo = useTreeUndo({
    treeId: tree.id,
    busy,
    blocked: dialog !== null || remove.isPending || move.isPending || rename.isPending,
    onApplied: onUndoApplied,
    onBusy: (error, retry) =>
      showBlockers({
        tree: tree.id,
        error,
        retry: { label: t('blockers.retry.undo'), run: retry },
      }),
  });
  /** Structural edits are paused while answers run or an undo runs. */
  const frozen = busy || undo.pending;

  /** Busy 409s go to the blockers dialog, never inline. */
  const inline = (error: unknown) => (error && !treeBusyDetailsOf(error) ? error : null);
  const actionError = inline(remove.error) ?? inline(move.error) ?? inline(rename.error);
  const resetErrors = () => {
    remove.reset();
    move.reset();
    rename.reset();
  };
  const openDialog = (kind: 'delete' | 'move') => {
    resetErrors();
    setDialog(kind);
  };
  // The focused question is not a node: no implicit rename target while it is shown.
  const renameTarget = renameTargetOf(selection, focus.main !== null ? '' : currentId);
  const openRename = (target: string) => {
    resetErrors();
    setRenameId(target);
    setDialog('rename');
  };

  const onNodeClick: NodeMouseHandler<BoxNode> = (event, node) => {
    if (node.data.ghost) return;
    if (node.data.pendingKey !== null) {
      setSelection(new Set());
      onOpenPending(node.data.pendingKey);
      return;
    }
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
          hit.data.pendingKey === null &&
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

  useEffect(() => {
    if (escArmed === null) return;
    const timer = setTimeout(() => setEscArmed(null), ESC_ARM_MS);
    return () => clearTimeout(timer);
  }, [escArmed]);

  const cancelPending = (status: PendingStatusInfo) => {
    if (status.outboxId !== null) store.abortOutbox(status.outboxId);
    else if (status.questionId !== null)
      store
        .cancel(status.questionId)
        .catch((error: unknown) =>
          pushNotice({ kind: 'error', message: describeError(error).message }),
        );
  };

  /** Keyboard on a focused pending box: Enter opens it, Esc twice cancels a running one. */
  const onGraphKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = event.target instanceof Element ? event.target : null;
    const id = element?.closest('.react-flow__node')?.getAttribute('data-id');
    if (!id || !isPendingFlowId(id)) return;
    const key = id.slice(PENDING_PREFIX.length);
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpenPending(key);
      return;
    }
    if (event.key !== 'Escape') return;
    const status = statuses[key];
    if (!status || !CANCELLABLE.has(status.status)) return;
    if (escArmed === key) {
      setEscArmed(null);
      cancelPending(status);
    } else setEscArmed(key);
  };

  const selected = [...selection];
  const topSelected = topLevelIds(selected);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keys of the focused pending box bubble here
    <div className="graph" ref={pane} onKeyDown={onGraphKeyDown}>
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
        {busy && (
          <span className="graph-busy muted small">
            {t('busyCount', { count: Math.max(1, runningCount) })}
            <Button size="sm" variant="ghost" onClick={() => showBlockers({ tree: tree.id })}>
              {t('showBlockers')}
            </Button>
          </span>
        )}
        {reconnecting && (
          <span className="graph-reconnecting muted small">{t('reconnecting')}</span>
        )}
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
        error={inline(remove.error)}
        onConfirm={() => remove.mutate(selected)}
        onClose={() => setDialog(null)}
      />
      <MoveDialog
        open={dialog === 'move'}
        title={tree.title}
        nodes={tree.nodes}
        selection={selected}
        pending={move.isPending}
        error={inline(move.error)}
        onConfirm={(target) => move.mutate({ ids: selected, target })}
        onClose={() => setDialog(null)}
      />
      <RenameDialog
        open={dialog === 'rename'}
        currentName={findNode(tree.nodes, renameId)?.name ?? nameOf(renameId)}
        pending={rename.isPending}
        error={inline(rename.error)}
        onConfirm={(name) => rename.mutate({ id: renameId, name })}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
