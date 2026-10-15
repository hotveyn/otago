import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUGGESTIONS_MARKER } from '../../../server/src/storage/suggestion-block';
import { ApiError } from '../../../web/src/api/client';
import type { QuestionStreamEvent, TreeBusyDetails } from '../../../web/src/api/types';
import { extractCitations } from '../../../web/src/lib/citations';
import { demoConnection } from './connection';
import { parseNodeFile } from './format';
import { type BlockStep, makeDemo, NODE, SMALL_SEED, scriptedBlocks } from './test-helpers';

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

// Mirrors contracts/prompt.ts (clickable-citations).
const PROMPT_EXAMPLE_FOOTNOTE_RE =
  /^\[\^[^\]\s]+\]: (?:(?:[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}-]*\/)*(?:sources|files)\/[^\s:]+(?: [^:]+?)?\.(?:md|txt|pdf):\d+(?:-\d+)?|https?:\/\/\S+)(?:\s+\S.*)?$/u;

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

  it('answers cite the tree sources and the message files with machine-readable footnotes', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    const pdf = `%PDF-1.4\n${[1, 2, 3].map((n) => `${n} 0 obj\n<< /Type /Page >>\nendobj\n`).join('')}`;
    demo.vfs.transaction(() => demo.vfs.writeText('t/sources/guide.pdf', pdf));
    await demo.api.startQuestion('t', {
      parentId: 'a',
      text: 'Cite please',
      context: { kind: 'main' },
      files: [new File(['one\ntwo\nthree\n'], 'draft.md')],
    });
    await vi.runAllTimersAsync();
    const node = (await demo.api.getChain('t', 'a/cite-please')).at(-1);
    const assistant = node?.assistant ?? '';
    const streamed = events.flatMap((e) => (e.event === 'chunk' ? [e.data.text] : [])).join('');
    expect(assistant).toBe(streamed.trim());
    // The default simulator appended a block: stripped, the footnotes stay the end.
    expect(assistant).not.toContain('<!--');
    expect(assistant.split('\n').at(-1)).toMatch(/^\[\^\d+\]: /);

    const definitions = assistant.split('\n').filter((line) => /^\[\^\d+\]: /.test(line));
    expect(definitions).toHaveLength(3);
    for (const line of definitions) expect(line).toMatch(PROMPT_EXAMPLE_FOOTNOTE_RE);
    const pdfLine = /^\[\^1\]: sources\/guide\.pdf:(\d+)(?:-(\d+))? \([a-z ]+\)$/.exec(
      definitions[0] ?? '',
    );
    expect(pdfLine, definitions[0]).not.toBeNull();
    expect(Number(pdfLine?.[2] ?? pdfLine?.[1])).toBeLessThanOrEqual(3);
    expect(definitions[1]).toBe('[^2]: sources/notes.md:1');
    const fileLine = /^\[\^3\]: files\/draft\.md:(\d+)(?:-(\d+))?(?: \([a-z ]+\))?$/.exec(
      definitions[2] ?? '',
    );
    expect(fileLine, definitions[2]).not.toBeNull();
    expect(Number(fileLine?.[2] ?? fileLine?.[1])).toBeLessThanOrEqual(3);
    expect(assistant).not.toMatch(/\S\[\^[^\]\s]+\]:/);

    // The SAME web parser resolves the mock's citations.
    const targets = extractCitations(assistant).citations.map((c) => c.target);
    expect(targets).toEqual([
      expect.objectContaining({
        kind: 'source',
        file: 'guide.pdf',
        start: expect.any(Number),
        end: expect.any(Number),
        comment: expect.any(String),
      }),
      { kind: 'source', file: 'notes.md', start: 1, end: 1 },
      expect.objectContaining({
        kind: 'file',
        node: undefined,
        name: 'draft.md',
        start: expect.any(Number),
        end: expect.any(Number),
      }),
    ]);
  });

  it('cites an ancestor user file by node id', async () => {
    const { demo } = makeDemo();
    demo.vfs.transaction(() => demo.vfs.writeText('t/a/files/spec.txt', 'one\ntwo\n'));
    await demo.api.startQuestion('t', {
      parentId: 'a/b',
      text: 'Deeper',
      context: { kind: 'main' },
    });
    await vi.runAllTimersAsync();
    const assistant = (await demo.api.getChain('t', 'a/b/deeper')).at(-1)?.assistant ?? '';
    const line = assistant.split('\n').find((l) => l.startsWith('[^2]: '));
    expect(line).toMatch(/^\[\^2\]: a\/files\/spec\.txt:(?:1|2|1-2)(?: \([a-z ]+\))?$/);
    expect(line).toMatch(PROMPT_EXAMPLE_FOOTNOTE_RE);
    const targets = extractCitations(assistant).citations.map((c) => c.target);
    expect(targets[1]).toMatchObject({ kind: 'file', node: 'a', name: 'spec.txt' });
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

/** Node id of the question's `done` event. */
function doneNodeOf(events: QuestionStreamEvent[], id: string): string {
  for (const e of events) {
    const question = e.event === 'question' ? e.data.question : undefined;
    if (question?.id === id && question.status === 'done') return question.nodeId;
  }
  throw new Error(`Question ${id} is not done`);
}

describe('simulated questions: suggestion block', () => {
  const main = { kind: 'main' } as const;
  const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

  function setup(
    steps: BlockStep[] = [],
    extra: Record<string, string> = {},
    fallback?: BlockStep,
  ) {
    const script = scriptedBlocks(steps, fallback);
    const { demo } = makeDemo({ seed: { ...SMALL_SEED, ...extra }, suggest: script.simulate });
    const events = record(demo);
    const chunks = () => events.flatMap((e) => (e.event === 'chunk' ? [e.data] : []));
    const streamed = () =>
      chunks()
        .map((chunk) => chunk.text)
        .join('');
    const ask = async (parentId: string, text: string, files?: File[]) => {
      const { id } = await demo.api.startQuestion('t', { parentId, text, context: main, files });
      await vi.runAllTimersAsync();
      return doneNodeOf(events, id);
    };
    const raw = (nodeId: string) => demo.vfs.readText(`t/${nodeId}/node.md`) ?? '';
    const stored = (nodeId: string) => parseNodeFile(raw(nodeId)).suggestions;
    const assistantOf = async (nodeId: string) =>
      (await demo.api.getChain('t', nodeId)).at(-1)?.assistant ?? '';
    return { demo, script, events, chunks, streamed, ask, raw, stored, assistantOf };
  }

  const expectContiguous = (chunks: Array<{ offset: number; text: string }>) => {
    let text = '';
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(text.length);
      text += chunk.text;
    }
  };

  it('strips the block from chunks and the answer and stores its items with the node', async () => {
    const { demo, script, events, chunks, streamed, ask, stored, assistantOf } = setup([['Next?']]);
    let versionAtDone: number | undefined;
    demo.questions.subscribe((event) => {
      if (event.event === 'question' && event.data.question.status === 'done') {
        versionAtDone = demo.vfs.stat(`t/${event.data.question.nodeId}/node.md`)?.version;
      }
    });
    const nodeId = await ask('a', 'Why borrow?');
    expect(nodeId).toBe('a/why-borrow');
    expect(statuses(events)).toEqual(['streaming', 'naming', 'done']);
    expectContiguous(chunks());
    expect(streamed()).not.toContain('<!--');
    const assistant = await assistantOf(nodeId);
    expect(assistant).toBe(streamed().trim());
    expect(assistant).not.toContain(SUGGESTIONS_MARKER);
    expect(stored(nodeId)).toEqual([{ text: 'Next?', up: 0 }]);
    // Written once, together with the node.
    expect(versionAtDone).toBeDefined();
    expect(demo.vfs.stat(`t/${nodeId}/node.md`)?.version).toBe(versionAtDone);
    expect(script.calls).toEqual([
      { treeId: 't', parentId: 'a', question: 'Why borrow?', openSuggestions: [], attempt: 1 },
    ]);
  });

  it('never shows the block while streaming, nor to a connection opened mid-block', async () => {
    const items = Array.from({ length: 8 }, (_, i) => `Next question number ${i + 1}?`);
    const { demo, events, chunks, streamed, assistantOf } = setup([items]);
    const { id } = await demo.api.startQuestion('t', {
      parentId: 'a',
      text: 'Why?',
      context: main,
    });
    const shownWhileStreaming: string[] = [];
    while (!statuses(events).includes('done')) {
      await vi.advanceTimersToNextTimerAsync();
      expectContiguous(chunks());
      expect(streamed()).not.toContain('<!--');
      const entry = demo.questions.snapshot().questions.find((q) => q.id === id);
      expect(entry?.live?.answer ?? '').not.toContain('<!--');
      if (entry?.status !== 'streaming') continue;
      const received: QuestionStreamEvent[] = [];
      const connection = demoConnection(demo.questions)({
        onEvent: (event) => received.push(event),
        onStatus: () => undefined,
      });
      connection.start();
      connection.stop();
      const snapshot = received[0];
      const live =
        snapshot?.event === 'snapshot'
          ? snapshot.data.questions.find((q) => q.id === id)?.live?.answer
          : undefined;
      expect(live).toBeDefined();
      expect(live).not.toContain('<!--');
      shownWhileStreaming.push(live ?? '');
    }
    const assistant = await assistantOf(doneNodeOf(events, id));
    // Many streaming steps already showed the whole answer: the block was being withheld.
    expect(shownWhileStreaming.filter((text) => text.trim() === assistant).length).toBeGreaterThan(
      5,
    );
  });

  it('no block: no suggestions key, the node inherits the parent list', async () => {
    const { ask, raw, stored, demo } = setup([undefined], {
      't/a/node.md': NODE('A?', at(1), [{ text: 'P1', up: 0 }]),
    });
    const nodeId = await ask('a', 'Why?');
    expect(raw(nodeId)).not.toContain('suggestions:');
    expect(stored(nodeId)).toBeUndefined();
    expect((await demo.api.getSuggestions('t', nodeId)).suggestions).toEqual([
      { text: 'P1', target: 'a', up: 1 },
    ]);
  });

  it('the marker alone stores an empty list and stops inheritance', async () => {
    const { ask, stored, demo } = setup([[]], {
      't/a/node.md': NODE('A?', at(1), [{ text: 'P1', up: 0 }]),
    });
    const nodeId = await ask('a', 'Why?');
    expect(stored(nodeId)).toEqual([]);
    expect((await demo.api.getSuggestions('t', nodeId)).suggestions).toEqual([]);
  });

  it('a verbatim copy of an open suggestion keeps pointing at its owner', async () => {
    const { ask, stored, demo } = setup([['Глава 4'], ['Глава 4!']], {
      't/a/node.md': NODE('A?', at(1), [{ text: 'Глава 4', up: 0 }]),
    });
    const kept = await ask('a', 'Термин?');
    expect(stored(kept)).toEqual([{ text: 'Глава 4', up: 1 }]);
    expect((await demo.api.getSuggestions('t', kept)).suggestions).toEqual([
      { text: 'Глава 4', target: 'a', up: 1 },
    ]);
    // An edited copy is a new own item.
    const edited = await ask('a', 'Ещё термин?');
    expect(stored(edited)).toEqual([{ text: 'Глава 4!', up: 0 }]);
  });

  it('keeping an item twice stores it two levels up', async () => {
    const { ask, stored, demo } = setup([['X'], ['X']], {
      't/g/node.md': NODE('G?', at(1), [{ text: 'X', up: 0 }]),
    });
    const parent = await ask('g', 'Side?');
    expect(stored(parent)).toEqual([{ text: 'X', up: 1 }]);
    const child = await ask(parent, 'Deeper?');
    expect(stored(child)).toEqual([{ text: 'X', up: 2 }]);
    expect((await demo.api.getSuggestions('t', child)).suggestions).toEqual([
      { text: 'X', target: 'g', up: 2 },
    ]);
  });

  it('finalization drops the question itself, empty texts and duplicates; no cap', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `Item ${i + 1}?`);
    const { ask, stored } = setup([['Why?', '', 'Dup', ' Dup ', ...ten]]);
    const nodeId = await ask('a', 'Why?');
    expect(stored(nodeId)).toEqual([
      { text: 'Dup', up: 0 },
      ...ten.map((text) => ({ text, up: 0 })),
    ]);
  });

  it('cancel while the block is withheld creates no node and shows no block', async () => {
    const items = Array.from({ length: 8 }, (_, i) => `Next question number ${i + 1}?`);
    const { demo, events, chunks, streamed } = setup([items]);
    const before = demo.vfs.list('t/a');
    const { id } = await demo.api.startQuestion('t', {
      parentId: 'a',
      text: 'Why?',
      context: main,
    });
    // Step until two ticks in a row emitted nothing: the block's tokens are being pushed.
    let quiet = 0;
    while (quiet < 2) {
      const count = chunks().length;
      await vi.advanceTimersToNextTimerAsync();
      expect(statuses(events)).toEqual(['streaming']);
      quiet = chunks().length === count ? quiet + 1 : 0;
    }
    await demo.api.cancelQuestion(id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.at(-1)).toMatchObject({ event: 'removed', data: { reason: 'cancelled' } });
    expect(demo.vfs.list('t/a')).toEqual(before);
    expect(streamed()).not.toContain('<!--');
  });

  it('a failed attempt stores nothing; the retry asks again with recomputed candidates', async () => {
    const { demo, script, events, stored } = setup(
      [],
      { 't/a/node.md': NODE('A?', at(1), [{ text: 'P1', up: 0 }]) },
      (input) => (input.attempt === 1 ? ['First'] : ['Second']),
    );
    const { id } = await demo.api.startQuestion('t', {
      parentId: 'a',
      text: 'Please fail',
      context: main,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = demo.questions.snapshot().questions[0];
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.live?.answer).not.toContain('<!--');
    await demo.api.retryQuestion(id);
    await vi.advanceTimersByTimeAsync(60_000);
    const nodeId = doneNodeOf(events, id);
    expect(stored(nodeId)).toEqual([{ text: 'Second', up: 0 }]);
    expect(
      script.calls.map(({ attempt, openSuggestions }) => ({ attempt, openSuggestions })),
    ).toEqual([
      { attempt: 1, openSuggestions: ['P1'] },
      { attempt: 2, openSuggestions: ['P1'] },
    ]);
  });

  it('a files-only message stores the items of its block', async () => {
    const { ask, stored, script } = setup([['About the file?']]);
    const nodeId = await ask('', '', [new File(['one\ntwo\n'], 'draft.md')]);
    expect(script.calls[0]?.question).toBe('');
    expect(stored(nodeId)).toEqual([{ text: 'About the file?', up: 0 }]);
  });

  it('end to end with the default simulator: plan steps are inherited and hidden once asked', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    const ask = async (parentId: string, text: string) => {
      const { id } = await demo.api.startQuestion('t', { parentId, text, context: main });
      await vi.runAllTimersAsync();
      return doneNodeOf(events, id);
    };
    const step1 = "Let's start with step 1 of ownership";
    const step2 = "Let's go to step 2 of ownership";
    const step3 = "Let's go to step 3 of ownership";

    const plan = await ask('', 'Make a plan for ownership');
    expect((await demo.api.getSuggestions('t', plan)).suggestions).toEqual([
      { text: step1, target: plan, up: 0 },
      { text: step2, target: plan, up: 0 },
      { text: step3, target: plan, up: 0 },
    ]);

    const child = await ask(plan, step1);
    const stored = parseNodeFile(demo.vfs.readText(`t/${child}/node.md`) ?? '').suggestions;
    expect(stored).toEqual([
      { text: step2, up: 1 },
      { text: step3, up: 1 },
    ]);
    const inherited = async () =>
      (await demo.api.getSuggestions('t', child)).suggestions.filter((s) => s.up > 0);
    expect(await inherited()).toEqual([
      { text: step2, target: plan, up: 1 },
      { text: step3, target: plan, up: 1 },
    ]);
    // Step 1 is now used under the plan node.
    expect((await demo.api.getSuggestions('t', plan)).suggestions.map((s) => s.text)).toEqual([
      step2,
      step3,
    ]);

    await ask(plan, step2);
    expect(await inherited()).toEqual([{ text: step3, target: plan, up: 1 }]);
  });
});
