import { type CSSProperties, useCallback, useState } from 'react';
import { useTree, useTrees } from './api/queries';
import { AttachmentViewer } from './components/AttachmentViewer';
import { ChatView } from './components/chat/ChatView';
import { GraphView } from './components/graph/GraphView';
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
import { CHAT_MIN_WIDTH, clampChatWidth, usePaneLayout } from './lib/layout';
import { useUrlState } from './lib/url-state';

type ViewerTarget =
  | { kind: 'source'; view: SourceView }
  | { kind: 'attachment'; view: AttachmentView };

export function App() {
  const [url, navigate] = useUrlState();
  const trees = useTrees();
  const tree = useTree(url.tree);
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [streaming, setStreaming] = useState(false);
  const layout = usePaneLayout();
  const [resizing, setResizing] = useState(false);

  const openSource = useCallback((view: SourceView) => setViewer({ kind: 'source', view }), []);
  const openAttachment = useCallback(
    (view: AttachmentView) => setViewer({ kind: 'attachment', view }),
    [],
  );
  const closeViewer = useCallback(() => setViewer(null), []);
  const selectTree = useCallback(
    (id: string) => {
      setViewer(null);
      navigate({ tree: id, node: '' });
    },
    [navigate],
  );
  const setCurrent = useCallback((node: string) => navigate({ node }), [navigate]);

  return (
    <SourceViewerContext.Provider value={openSource}>
      <AttachmentViewerContext.Provider value={openAttachment}>
        <div
          className={[
            'app',
            layout.sidebarCollapsed ? 'app-sidebar-collapsed' : '',
            resizing ? 'app-resizing' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={
            {
              '--sidebar-w': `${layout.sidebarWidth}px`,
              '--chat-w': `${layout.chatWidth}px`,
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
                <p className="empty-title">Choose a tree or start a new one.</p>
                <p className="muted">Every question becomes a node. Branch wherever you like.</p>
              </div>
            ) : tree.error ? (
              <div className="empty-state">
                <ErrorNote error={tree.error} />
              </div>
            ) : tree.data ? (
              <GraphView
                tree={tree.data}
                currentId={url.node}
                busy={streaming}
                onSelectNode={setCurrent}
                onCurrentChange={(node) => navigate({ node }, true)}
              />
            ) : (
              <div className="empty-state muted">Loading…</div>
            )}
          </main>

          <section className="chat-pane">
            <Splitter
              value={layout.chatWidth}
              min={CHAT_MIN_WIDTH}
              max={clampChatWidth(Number.POSITIVE_INFINITY, layout.viewport, layout.sidebarWidth)}
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
                onStreamingChange={setStreaming}
              />
            )}
            {viewer?.kind === 'source' && url.tree && (
              <SourceViewer treeId={url.tree} view={viewer.view} onClose={closeViewer} />
            )}
            {viewer?.kind === 'attachment' && url.tree === viewer.view.treeId && (
              <AttachmentViewer view={viewer.view} onClose={closeViewer} />
            )}
          </section>
        </div>
      </AttachmentViewerContext.Provider>
    </SourceViewerContext.Provider>
  );
}
