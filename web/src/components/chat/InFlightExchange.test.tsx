import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import type { FailedQuestion, QuestionInfo, RunningQuestion } from '../../api/types';
import type { InFlightView, OutboxEntry } from '../../lib/questions';
import { type InFlightActions, InFlightExchange } from './InFlightExchange';

const running: RunningQuestion = {
  id: 'q',
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  text: 'Почему?',
  title: 'Почему?',
  files: [],
  model: 'claude-x',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: 'c',
  updatedAt: 'u',
};

const failed: FailedQuestion = {
  ...running,
  status: 'failed',
  error: { code: 'agent_error', message: 'rate limited' },
  files: [{ name: 'notes.pdf', size: 2048, contentType: 'application/pdf', kind: 'pdf' }],
};

const questionView = (info: QuestionInfo, text = ''): InFlightView => ({
  kind: 'question',
  info,
  stream: { attempt: info.attempt, text, attachments: [] },
  localFiles: null,
  cancelling: false,
});

const outbox = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'out-1',
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  stashKey: 't:main',
  text: 'Отправляю',
  files: [],
  phase: 'sending',
  error: null,
  createdAt: 'c',
  ...overrides,
});

const render = (view: InFlightView, actions: InFlightActions = {}) =>
  renderToStaticMarkup(<InFlightExchange treeId="t" view={view} actions={actions} />);

describe('InFlightExchange (server render smoke test)', () => {
  it('shows a streaming answer with a caret', () => {
    const html = render(questionView(running, 'Потому что'));
    expect(html).toContain('Почему?');
    expect(html).toContain('Потому что');
    expect(html).toContain('Answering…');
    expect(html).toContain('claude-x');
    expect(html).toContain('caret');
  });

  it('shows a saving answer without a caret', () => {
    const html = render(questionView({ ...running, status: 'naming' }, 'Complete answer'));
    expect(html).toContain('Saving…');
    expect(html).toContain('Complete answer');
    expect(html).not.toContain('caret');
  });

  it('shows a failed answer with a localized failure, Retry, Dismiss and staged files', () => {
    const html = render(questionView(failed, 'partial'), {
      retry: () => undefined,
      dismiss: () => undefined,
    });
    expect(html).toContain('Failed');
    expect(html).toContain('The answer failed: rate limited');
    expect(html).toContain('Retry');
    expect(html).toContain('Dismiss');
    expect(html).toContain('notes.pdf');
    expect(html).toContain('kept for retry');
    expect(html).not.toContain('caret');
  });

  it('explains a retry under a deleted parent', () => {
    const html = render(questionView(failed), {
      retry: () => undefined,
      retryError: new ApiError(404, 'Parent node not found: основы', 'parent_not_found'),
    });
    expect(html).toContain('no longer exists. Dismiss it and ask again elsewhere.');
  });

  it('shows a send that was not accepted with its error', () => {
    const html = render({
      kind: 'outbox',
      entry: outbox({ error: new ApiError(400, 'Unsupported file type', 'unsupported_file_type') }),
    });
    expect(html).toContain('Not sent');
    expect(html).toContain('Unsupported file type');
    expect(html).not.toContain('No answer.');
  });

  it('shows a send in progress without an empty-answer note', () => {
    const html = render({ kind: 'outbox', entry: outbox() });
    expect(html).toContain('Sending…');
    expect(html).toContain('Отправляю');
    expect(html).not.toContain('No answer.');
  });

  it('shows a focus that is still loading', () => {
    expect(render({ kind: 'loading', id: 'q' })).toContain('Loading…');
  });
});
