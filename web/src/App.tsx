import { type CSSProperties, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTree, useTrees } from './api/queries';
import { AttachmentViewer } from './components/AttachmentViewer';
import { ChatView } from './components/chat/ChatView';
import { SideChatView, type SideSeed } from './components/chat/SideChatView';
import { BlockersDialog } from './components/graph/BlockersDialog';
import { BlockersContext, type BlockersRequest } from './components/graph/blockers-context';
import { GraphView, type NodesChange } from './components/graph/GraphView';
import { QuestionEffects } from './components/QuestionEffects';
import { SourceViewer } from './components/SourceViewer';
import { Sidebar } from './components/sidebar/Sidebar';
import {
  type AttachmentView,
  AttachmentViewerContext,
  type SourceView,
  SourceViewerContext,
} from './components/source-viewer-context';
import { ErrorNote } from './components/ui/ErrorNote';
import { Notices } from './components/ui/Notices';
import { Splitter } from './components/ui/Splitter';
import { type BlockersOpened, treeBusyDetailsOf } from './lib/blockers';
import {
  CHAT_MIN_WIDTH,
  clampChatWidth,
  clampSideWidth,
  SIDE_MIN_WIDTH,
  usePaneLayout,
} from './lib/layout';
import { askAsideTarget, openPendingTarget } from './lib/question-focus';
import { useQuestionStore } from './lib/question-store';
import { afterMove } from './lib/tree';
import {
  closeSide,
  followTreeRename,
  promoteSide,
  readUrlState,
  remapSideAfterDelete,
  remapSideAfterMove,
  useUrlState,
} from './lib/url-state';
import { useFileDropGuard } from './lib/use-file-drop-guard';

type ViewerTarget =
  | { kind: 'source'; view: SourceView }
  | { kind: 'attachment'; view: AttachmentView };

interface OpenBlockers {
  id: number;
  request: BlockersRequest;
  opened: BlockersOpened;
}

const liveUrl = () => readUrlState(window.location.search);

export function App() {
  const { t } = useTranslation(['app', 'common']);
  const [url, navigate] = useUrlState();
  const store = useQuestionStore();
  const trees = useTrees();
  const tree = useTree(url.tree);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [sideSeed, setSideSeed] = useState<SideSeed | null>(null);
  const [blockers, setBlockers] = useState<OpenBlockers | null>(null);
  const seedNonce = useRef(0);
  const blockersNonce = useRef(0);
  const sideOpen = url.side !== null && tree.data != null;
  const layout = usePaneLayout(sideOpen);
  const [resizing, setResizing] = useState(false);
  useFileDropGuard();

  const openSource = useCallback((view: SourceView) => setViewer({ kind: 'source', view }), []);
  const openAttachment = useCallback(
    (view: AttachmentView) => setViewer({ kind: 'attachment', view }),
    [],
  );
  const closeViewer = useCallback(() => setViewer(null), []);
  const selectTree = useCallback(
    (id: string) => {
      setViewer(null);
      setSideSeed(null);
      // Also closes the side chat and the focus (see `mergeUrlState`).
      navigate({ tree: id, node: '' });
    },
    [navigate],
  );
  /** Selecting a node leaves the in-flight focus. */
  const setCurrent = useCallback((node: string) => navigate({ node, question: null }), [navigate]);
  /** The graph remapped the current node (move/delete/rename): keep a (failed) focus. */
  const onCurrentChange = useCallback(
    (node: string) => navigate({ node, question: liveUrl().question }, true),
    [navigate],
  );
  /** A pending box (or a blocker row): open its question in its own panel. */
  const openPending = useCallback(
    (key: string) => {
      const patch = openPendingTarget(key, store.getState());
      if (patch) navigate(patch);
    },
    [navigate, store],
  );

  // Ask aside from the current main focus: reuse the open aside on the same anchor, otherwise
  // open a new one (the previous aside's question keeps answering in the background).
  const askAside = useCallback(
    (text: string) => {
      const target = askAsideTarget(liveUrl());
      if (target === 'disabled') return;
      if (target) navigate(target);
      seedNonce.current += 1;
      setSideSeed({ nonce: seedNonce.current, text });
    },
    [navigate],
  );
  const consumeSeed = useCallback(
    (nonce: number) => setSideSeed((seed) => (seed?.nonce === nonce ? null : seed)),
    [],
  );
  const promote = useCallback(() => {
    const next = promoteSide(liveUrl());
    if (next) navigate(next);
  }, [navigate]);
  const close = useCallback(() => navigate(closeSide()), [navigate]);
  const onNodesChanged = useCallback(
    (change: NodesChange) => {
      const { tree: treeId, side } = liveUrl();
      const map =
        change.kind === 'move'
          ? change.moved
          : change.kind === 'rename'
            ? change.renamed
            : change.kind === 'restore'
              ? change.restored
              : null;
      // Mirror the server's remap of retained questions until its events arrive. A restore
      // changes no question (the server does not remap on restore).
      if (treeId !== null) {
        if (change.kind === 'delete')
          store.applyLocal({ kind: 'dropUnder', tree: treeId, ids: change.ids });
        else if (change.kind !== 'restore' && map)
          store.applyLocal({ kind: 'remap', tree: treeId, map });
      }
      // An open attachment viewer follows its node to the new id.
      if (map)
        setViewer((current) => {
          if (current?.kind !== 'attachment' || current.view.treeId !== treeId) return current;
          const nodeId = afterMove(current.view.nodeId, map);
          return nodeId === current.view.nodeId
            ? current
            : { kind: 'attachment', view: { ...current.view, nodeId } };
        });
      if (!side) return;
      const next =
        change.kind === 'delete'
          ? remapSideAfterDelete(side, change.ids)
          : remapSideAfterMove(side, map ?? {});
      if (next !== side) navigate({ side: next }, true);
    },
    [navigate, store],
  );
  // Tree folder renamed: same node and side chat under the new tree id.
  const onTreeRenamed = useCallback(
    (from: string, to: string) => {
      // Questions first, so the URL reconcile never sees them under the old id.
      store.applyLocal({ kind: 'renameTree', from, to });
      navigate(followTreeRename(liveUrl(), from, to), true);
      setViewer((current) =>
        current?.kind === 'attachment' && current.view.treeId === from
          ? { kind: 'attachment', view: { ...current.view, treeId: to } }
          : current,
      );
    },
    [navigate, store],
  );

  const showBlockers = useCallback(
    (request: BlockersRequest) => {
      blockersNonce.current += 1;
      setBlockers({
        id: blockersNonce.current,
        request,
        opened: {
          details: treeBusyDetailsOf(request.error),
          snapshotCount: store.getState().snapshotCount,
        },
      });
    },
    [store],
  );
  const closeBlockers = useCallback(() => setBlockers(null), []);

  return (
    <BlockersContext.Provider value={showBlockers}>
      <SourceViewerContext.Provider value={openSource}>
        <AttachmentViewerContext.Provider value={openAttachment}>
          <div
            className={[
              'app',
              layout.sidebarCollapsed ? 'app-sidebar-collapsed' : '',
              resizing ? 'app-resizing' : '',
              sideOpen ? 'app-side-open' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={
              {
                '--sidebar-w': `${layout.sidebarWidth}px`,
                '--chat-w': `${layout.chatWidth}px`,
                '--side-w': `${layout.sideWidth}px`,
              } as CSSProperties
            }
          >
            <Sidebar
              collapsed={layout.sidebarCollapsed}
              onToggle={layout.toggleSidebar}
              trees={trees.data ?? []}
              treesError={trees.error}
              tree={tree.data ?? null}
              currentTreeId={url.tree}
              onSelectTree={selectTree}
              onTreeRenamed={onTreeRenamed}
            />

            <main className="graph-pane">
              {url.tree === null ? (
                <div className="empty-state">
                  <p className="empty-title">{t('emptyTitle')}</p>
                  <p className="muted">{t('emptyHint')}</p>
                </div>
              ) : tree.error ? (
                <div className="empty-state">
                  <ErrorNote error={tree.error} />
                </div>
              ) : tree.data ? (
                <GraphView
                  tree={tree.data}
                  currentId={url.node}
                  focus={{ main: url.question, side: url.side?.question ?? null }}
                  onSelectNode={setCurrent}
                  onCurrentChange={onCurrentChange}
                  onNodesChanged={onNodesChanged}
                  onOpenPending={openPending}
                />
              ) : (
                <div className="empty-state muted">{t('common:loading')}</div>
              )}
              <Notices />
            </main>

            <section className="chat-pane">
              <Splitter
                value={layout.chatWidth}
                min={CHAT_MIN_WIDTH}
                max={clampChatWidth(
                  Number.POSITIVE_INFINITY,
                  layout.viewport,
                  layout.sidebarWidth,
                  sideOpen ? layout.sideWidth : 0,
                )}
                onChange={layout.setChatWidth}
                onReset={layout.resetChatWidth}
                onDragChange={setResizing}
              />
              {tree.data && (
                <ChatView
                  key={tree.data.id}
                  tree={tree.data}
                  currentId={url.node}
                  question={url.question}
                  onSelectNode={setCurrent}
                  onAskAside={url.question ? null : askAside}
                />
              )}
              {viewer?.kind === 'source' && url.tree && (
                <SourceViewer treeId={url.tree} view={viewer.view} onClose={closeViewer} />
              )}
              {viewer?.kind === 'attachment' && url.tree === viewer.view.treeId && (
                <AttachmentViewer view={viewer.view} onClose={closeViewer} />
              )}
            </section>

            {url.side && tree.data && (
              <section className="chat-pane side-pane" aria-label={t('sideChat')}>
                <Splitter
                  value={layout.sideWidth}
                  min={SIDE_MIN_WIDTH}
                  max={clampSideWidth(
                    Number.POSITIVE_INFINITY,
                    layout.viewport,
                    layout.sidebarWidth,
                  )}
                  onChange={layout.setSideWidth}
                  onReset={layout.resetSideWidth}
                  onDragChange={setResizing}
                  label={t('resizeSideChat')}
                />
                <SideChatView
                  key={`${tree.data.id}:${url.side.anchor}`}
                  tree={tree.data}
                  side={url.side}
                  seed={sideSeed}
                  onSeedConsumed={consumeSeed}
                  onPromote={promote}
                  onClose={close}
                />
              </section>
            )}
          </div>
          <QuestionEffects url={url} navigate={navigate} />
          {blockers && (
            <BlockersDialog
              key={blockers.id}
              tree={blockers.request.tree}
              opened={blockers.opened}
              retry={blockers.request.retry}
              onClose={closeBlockers}
              onOpenQuestion={openPending}
            />
          )}
        </AttachmentViewerContext.Provider>
      </SourceViewerContext.Provider>
    </BlockersContext.Provider>
  );
}
