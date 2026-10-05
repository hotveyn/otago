import '@fontsource-variable/source-serif-4/opsz.css';
import '@fontsource-variable/source-serif-4/opsz-italic.css';
import '@fontsource-variable/jetbrains-mono';
import '@xyflow/react/dist/base.css';
import './styles/themes.css';
import './styles/base.css';
import './styles/markdown.css';
import './styles/graph.css';
import './i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './api/client';
import { createQuestionStore, QuestionStoreContext } from './lib/question-store';
import { startQuestionSync } from './lib/question-sync';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// One store and one event stream per tab, created outside React so StrictMode's double
// effects cannot open a second stream.
const questionStore = createQuestionStore({ api });
const stopSync = startQuestionSync(questionStore);
import.meta.hot?.dispose(stopSync);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <QuestionStoreContext.Provider value={questionStore}>
        <App />
      </QuestionStoreContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
