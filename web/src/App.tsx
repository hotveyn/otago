import { type CSSProperties, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTree, useTrees } from './api/queries';
import { AttachmentViewer } from './components/AttachmentViewer';
import { ChatView } from './components/chat/ChatView';
import { SideChatView, type SideSeed } from './components/chat/SideChatView';
import { GraphView, type NodesChange } from './components/graph/GraphView';
import { SourceViewer } from './components/SourceViewer';
import { Sidebar } from './components/sidebar/Sidebar';
import {
  type AttachmentView,
  AttachmentViewerContext,
  type SourceView,
  SourceViewerContext,
} from './components/source-viewer-context';
import { ErrorNote } from './components/ui/ErrorNote';
import { Splitter } from './components/ui/Splitter';
import {
  CHAT_MIN_WIDTH,
  clampChatWidth,
  clampSideWidth,
  SIDE_MIN_WIDTH,
  usePaneLayout,
} from './lib/layout';
import {
  advanceSide,
  closeSide,
  openSide,
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

export function App() {
  const { t } = useTranslation(['app', 'common']);
  const [url, navigate] = useUrlState();
  const trees = useTrees();
  const tree = useTree(url.tree);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [mainStreaming, setMainStreaming] = useState(false);
  const [sideStreaming, setSideStreaming] = useState(false);
  const [sideSeed, setSideSeed] = useState<SideSeed | null>(null);
  const seedNonce = useRef(0);
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
      // Also closes the side chat (see `mergeUrlState`).
      navigate({ tree: id, node: '' });
    },
    [navigate],
  );
  const setCurrent = useCallback((node: string) => navigate({ node }), [navigate]);

  // Ask aside from the current main focus: reuse the open side chat on the same anchor.
  const askAside = useCallback(
    (text: string) => {
      const current = readUrlState(window.location.search);
      if (current.side?.anchor !== current.node) navigate(openSide(current, current.node));
      seedNonce.current += 1;
      setSideSeed({ nonce: seedNonce.current, text });
    },
    [navigate],
  );
  const consumeSeed = useCallback(
    (nonce: number) => setSideSeed((seed) => (seed?.nonce === nonce ? null : seed)),
    [],
  );
  // Read the live URL: the stream may finish after other navigation.
  const advance = useCallback(
    (anchor: string, nodeId: string) =>
      navigate(advanceSide(readUrlState(window.location.search), nodeId, anchor), true),
    [navigate],
  );
  const promote = useCallback(() => {
    const next = promoteSide(readUrlState(window.location.search));
    if (next) navigate(next);
  }, [navigate]);
  const close = useCallback(() => {
    navigate(closeSide());
    setSideStreaming(false);
  }, [navigate]);
  const onNodesChanged = useCallback(
    (change: NodesChange) => {
      const side = readUrlState(window.location.search).side;
      if (!side) return;
      const next =
        change.kind === 'move'
          ? remapSideAfterMove(side, change.moved)
          : remapSideAfterDelete(side, change.ids);
      if (next !== side) navigate({ side: next }, true);
    },
    [navigate],
  );

  return (
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
                busy={mainStreaming || sideStreaming}
                onSelectNode={setCurrent}
                onCurrentChange={(node) => navigate({ node }, true)}
                onNodesChanged={onNodesChanged}
              />
            ) : (
              <div className="empty-state muted">{t('common:loading')}</div>
            )}
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
                onSelectNode={setCurrent}
                onStreamingChange={setMainStreaming}
                onAskAside={askAside}
                askAsideEnabled={!sideStreaming}
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
                max={clampSideWidth(Number.POSITIVE_INFINITY, layout.viewport, layout.sidebarWidth)}
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
                onAdvance={(nodeId) => advance(url.side?.anchor ?? '', nodeId)}
                onPromote={promote}
                onClose={close}
                onStreamingChange={setSideStreaming}
              />
            </section>
          )}
        </div>
      </AttachmentViewerContext.Provider>
    </SourceViewerContext.Provider>
  );
}
