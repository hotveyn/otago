// Same composition as web/src/main.tsx, plus the mock backend: imports of the real API client
// resolve to ./mock/client (see vite.config.ts), and the question stream comes from the mock.
import '@fontsource-variable/source-serif-4/opsz.css';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/base.css';
import '../../web/src/styles/themes.css';
import '../../web/src/styles/base.css';
import '../../web/src/styles/markdown.css';
import '../../web/src/styles/graph.css';
import './demo.css';
import '../../web/src/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../web/src/App';
import { createQuestionStore, QuestionStoreContext } from '../../web/src/lib/question-store';
import { startQuestionSync } from '../../web/src/lib/question-sync';
import { readUrlState, writeUrlState } from '../../web/src/lib/url-state';
import { DemoBanner } from './DemoBanner';
import { api } from './mock/client';
import { demoConnection } from './mock/connection';
import { demo } from './mock/runtime';

// First visit (no tree in the URL): open the first tree at its first node.
if (readUrlState(location.search).tree === null) {
  const [tree] = demo.trees.listTrees();
  if (tree) {
    const node = demo.trees.hierarchy(tree.id)[0]?.id ?? '';
    const search = writeUrlState({ tree: tree.id, node, question: null, side: null });
    history.replaceState(history.state, '', `${location.pathname}${search}`);
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const questionStore = createQuestionStore({ api });
// No HTTP connection to save: hidden tabs stay connected.
const stopSync = startQuestionSync(questionStore, {
  connect: demoConnection(demo.questions),
  hiddenDisconnectMs: null,
});
import.meta.hot?.dispose(stopSync);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <QuestionStoreContext.Provider value={questionStore}>
        <App />
        <DemoBanner />
      </QuestionStoreContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
