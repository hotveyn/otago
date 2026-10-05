import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../web/src/api/client';
import type { QuestionStreamEvent, TreeBusyDetails } from '../../../web/src/api/types';
import { demoConnection } from './connection';
import { makeDemo } from './test-helpers';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function record(demo: ReturnType<typeof makeDemo>['demo']) {
  const events: QuestionStreamEvent[] = [];
  demo.questions.subscribe((event) => events.push(event));
  return events;
}

const statuses = (events: QuestionStreamEvent[]) =>
  events.flatMap((e) => (e.event === 'question' ? [e.data.question.status] : []));

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('simulated questions', () => {
  it('streams contiguous chunks, then names and commits the node', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    const question = await demo.api.startQuestion('t', {
      parentId: 'a',
      text: 'How does borrowing work?',
      context: { kind: 'main' },
    });
    expect(question).toMatchObject({ status: 'streaming', attempt: 1, parentId: 'a' });
    expect(question.title).toBe('How does borrowing work?');

    await vi.runAllTimersAsync();

    const chunks = events.flatMap((e) => (e.event === 'chunk' ? [e.data] : []));
    expect(chunks.length).toBeGreaterThan(10);
    let answer = '';
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(answer.length);
      answer += chunk.text;
    }
    expect(statuses(events)).toEqual(['streaming', 'naming', 'done']);
    const done = events.filter((e) => e.event === 'question').at(-1);
    expect(done?.event === 'question' && done.data.question).toMatchObject({
      status: 'done',
      nodeId: 'a/how-does-borrowing-work',
    });
    const chain = await demo.api.getChain('t', 'a/how-does-borrowing-work');
    expect(chain.at(-1)).toMatchObject({
      user: 'How does borrowing work?',
      assistant: answer.trim(),
    });
  });

  it('expires done entries after 30 minutes', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    await demo.api.startQuestion('t', { parentId: '', text: 'Q', context: { kind: 'main' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demo.questions.snapshot().questions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(demo.questions.snapshot().questions).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      event: 'removed',
      data: { reason: 'expired', nodeId: 'q' },
    });
  });

  it('blocks structural changes while streaming (409 with blockers), not after', async () => {
    const { demo } = makeDemo();
    const question = await demo.api.startQuestion('t', {
      parentId: 'c',
      text: 'Why?',
      context: { kind: 'main' },
    });
    const error = await rejection(demo.api.moveNodes('t', ['a'], 'c'));
    expect(error).toMatchObject({ status: 409, code: 'tree_busy_streaming' });
    const details = error.details as TreeBusyDetails;
    expect(details.preparing).toBe(0);
    expect(details.questions).toEqual([
      expect.objectContaining({ id: question.id, title: 'Why?', status: 'streaming' }),
    ]);
    await vi.runAllTimersAsync();
    await expect(demo.api.moveNodes('t', ['a'], 'c')).resolves.toMatchObject({
      moved: { a: 'c/a' },
    });
  });

  it('cancels a running question and refuses to cancel a done one', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    const running = await demo.api.startQuestion('t', {
      parentId: '',
      text: 'Stop me',
      context: { kind: 'main' },
    });
    await vi.advanceTimersByTimeAsync(600);
    await demo.api.cancelQuestion(running.id);
    expect(events.at(-1)).toMatchObject({ event: 'removed', data: { reason: 'cancelled' } });
    await vi.runAllTimersAsync();
    expect((await demo.api.getTree('t')).nodes.map((n) => n.id)).toEqual(['a', 'c']);

    const finished = await demo.api.startQuestion('t', {
      parentId: '',
      text: 'Finish me',
      context: { kind: 'main' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await rejection(demo.api.cancelQuestion(finished.id));
    expect(error).toMatchObject({
      status: 409,
      code: 'question_finished',
      details: { nodeId: 'finish-me' },
    });
  });

  it('fails questions containing "fail" once, then a retry succeeds', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    const question = await demo.api.startQuestion('t', {
      parentId: '',
      text: 'Please fail',
      context: { kind: 'main' },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = demo.questions.snapshot().questions[0];
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'agent_error' } });
    expect(failed?.live?.answer.length).toBeGreaterThan(0);

    const retried = await demo.api.retryQuestion(question.id);
    expect(retried).toMatchObject({ id: question.id, attempt: 2, status: 'streaming' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses(events)).toEqual(['streaming', 'failed', 'streaming', 'naming', 'done']);
    expect((await rejection(demo.api.retryQuestion(question.id))).code).toBe('question_not_failed');
  });

  it('validates input like the server', async () => {
    const { demo } = makeDemo();
    const main = { kind: 'main' } as const;
    expect(
      (await rejection(demo.api.startQuestion('t', { parentId: 'zz', text: 'Q', context: main })))
        .code,
    ).toBe('parent_not_found');
    expect(
      (await rejection(demo.api.startQuestion('t', { parentId: '', text: '  ', context: main })))
        .code,
    ).toBe('empty_message');
    const book = new File(['x'], 'book.epub');
    expect(
      (
        await rejection(
          demo.api.startQuestion('t', { parentId: '', text: '', context: main, files: [book] }),
        )
      ).code,
    ).toBe('unsupported_file_type');
    expect(
      (
        await rejection(
          demo.api.startQuestion('t', {
            parentId: 'c',
            text: 'Q',
            context: { kind: 'side', anchor: 'a' },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await rejection(
          demo.api.startQuestion('t', { parentId: '', text: 'Q', model: 'gpt', context: main }),
        )
      ).message,
    ).toMatch(/Unknown model "gpt"/);
  });

  it('stores user files with the node, files-only messages are titled by the files', async () => {
    const { demo } = makeDemo();
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'Screen Shot.png', {
      type: 'image/png',
    });
    const question = await demo.api.startQuestion('t', {
      parentId: '',
      text: '',
      context: { kind: 'main' },
      files: [image],
    });
    expect(question.title).toBe('Screen-Shot.png');
    expect(question.files).toEqual([
      { name: 'Screen-Shot.png', size: 4, contentType: 'image/png', kind: 'image' },
    ]);
    await vi.runAllTimersAsync();
    const chain = await demo.api.getChain('t', 'attached-files-screen-shot');
    expect(chain[0]?.files.map((file) => file.name)).toEqual(['Screen-Shot.png']);
  });

  it('remaps retained questions on move, tree rename and delete', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    await demo.api.startQuestion('t', { parentId: 'c', text: 'Q', context: { kind: 'main' } });
    await vi.advanceTimersByTimeAsync(60_000);
    await demo.api.moveNodes('t', ['c'], 'a');
    expect(demo.questions.snapshot().questions[0]).toMatchObject({
      parentId: 'a/c',
      nodeId: 'a/c/q',
    });
    await demo.api.updateTree('t', { title: 'Renamed' });
    expect(demo.questions.snapshot().questions[0]).toMatchObject({ tree: 'renamed' });
    await demo.api.deleteNodes('renamed', ['a']);
    expect(demo.questions.snapshot().questions).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ event: 'removed', data: { reason: 'deleted' } });
  });

  it('connection starts with a snapshot and follows the registry', async () => {
    const { demo } = makeDemo();
    const received: string[] = [];
    const status: string[] = [];
    const connection = demoConnection(demo.questions)({
      onEvent: (event) => received.push(event.event),
      onStatus: (s) => status.push(s),
    });
    connection.start();
    await demo.api.startQuestion('t', { parentId: '', text: 'Q', context: { kind: 'main' } });
    connection.stop();
    await vi.runAllTimersAsync();
    expect(received).toEqual(['snapshot', 'question']);
    expect(status).toEqual(['connecting', 'live', 'paused']);
    connection.resync();
    expect(received.at(-1)).toBe('snapshot');
  });
});
