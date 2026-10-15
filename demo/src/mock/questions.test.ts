import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../web/src/api/client';
import type { QuestionStreamEvent, TreeBusyDetails } from '../../../web/src/api/types';
import { extractCitations } from '../../../web/src/lib/citations';
import { demoConnection } from './connection';
import { parseNodeFile } from './format';
import { makeDemo, type ScriptStep, scriptedSuggest } from './test-helpers';

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

describe('simulated questions: suggestions at save', () => {
  const main = { kind: 'main' } as const;

  function setup(...steps: ScriptStep[]) {
    const script = scriptedSuggest(steps);
    const { demo } = makeDemo({ suggest: script.simulate });
    const events = record(demo);
    const doneNode = () => {
      const done = events.find((e) => e.event === 'question' && e.data.question.status === 'done');
      return done?.event === 'question' && done.data.question.status === 'done'
        ? done.data.question.nodeId
        : undefined;
    };
    const stored = (nodeId: string) =>
      parseNodeFile(demo.vfs.readText(`t/${nodeId}/node.md`) ?? '').suggestions;
    return { demo, script, events, doneNode, stored };
  }

  it('a generation faster than naming is written together with the node', async () => {
    const { demo, script, events, stored } = setup({ delayMs: 100, picks: [{ text: 'Next?' }] });
    let versionAtCommit: number | undefined;
    demo.questions.subscribe((event) => {
      if (event.event === 'question' && event.data.question.status === 'done') {
        const nodeId = event.data.question.nodeId;
        versionAtCommit = demo.vfs.stat(`t/${nodeId}/node.md`)?.version;
      }
    });
    await demo.api.startQuestion('t', { parentId: 'a', text: 'Why borrow?', context: main });
    await vi.runAllTimersAsync();
    expect(statuses(events)).toEqual(['streaming', 'naming', 'done']);
    expect(stored('a/why-borrow')).toEqual([{ text: 'Next?', up: 0 }]);
    expect(versionAtCommit).toBeDefined();
    expect(demo.vfs.stat('t/a/why-borrow/node.md')?.version).toBe(versionAtCommit);
    expect(script.calls[0]?.input).toMatchObject({
      treeId: 't',
      ancestors: [{ id: 'a', user: 'A?', assistant: 'Answer to A?' }],
      current: { user: 'Why borrow?' },
    });
    expect(script.calls[0]?.input.nodeId).toBeUndefined();
  });

  it('a slower generation is adopted after the commit; a POST joins it', async () => {
    const { demo, script, events, doneNode, stored } = setup({ picks: 'gate' });
    await demo.api.startQuestion('t', { parentId: 'a', text: 'Slow one', context: main });
    await vi.runAllTimersAsync();
    expect(statuses(events)).toEqual(['streaming', 'naming', 'done']);
    const nodeId = doneNode() ?? '';
    expect(nodeId).toBe('a/slow-one');
    expect(stored(nodeId)).toBeUndefined();
    expect(demo.suggestions.inFlight()).toBe(1);
    expect(await demo.api.getSuggestions('t', nodeId)).toMatchObject({ state: 'missing' });
    const post = demo.api.generateSuggestions('t', nodeId);
    expect(script.calls).toHaveLength(1);
    script.calls[0]?.open([{ text: 'Later?' }]);
    await vi.runAllTimersAsync();
    expect(await post).toEqual({
      node: nodeId,
      state: 'ready',
      suggestions: [{ text: 'Later?', target: nodeId, up: 0 }],
    });
    expect(stored(nodeId)).toEqual([{ text: 'Later?', up: 0 }]);
    expect(script.calls).toHaveLength(1);
    expect(demo.suggestions.inFlight()).toBe(0);
  });

  it('a failed generation leaves the node missing and changes no event', async () => {
    const { demo, events, doneNode, stored } = setup({ delayMs: 10, picks: 'fail' });
    await demo.api.startQuestion('t', { parentId: '', text: 'Q', context: main });
    await vi.runAllTimersAsync();
    expect(statuses(events)).toEqual(['streaming', 'naming', 'done']);
    expect(stored(doneNode() ?? '')).toBeUndefined();
  });

  it('cancel during naming aborts the generation: no node, nothing written later', async () => {
    const { demo, script, events } = setup({ delayMs: 5_000, picks: [{ text: 'Never?' }] });
    const question = await demo.api.startQuestion('t', { parentId: 'c', text: 'Q', context: main });
    while (!statuses(events).includes('naming')) await vi.advanceTimersToNextTimerAsync();
    expect(script.calls).toHaveLength(1);
    await demo.api.cancelQuestion(question.id);
    expect(script.calls[0]?.input.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(demo.vfs.list('t/c')).toEqual(['node.md']);
    expect(demo.suggestions.inFlight()).toBe(0);
  });

  it('a failing answer starts no generation; its retry starts one at naming', async () => {
    const { demo, script, events, doneNode, stored } = setup({
      delayMs: 10,
      picks: [{ text: 'After retry?' }],
    });
    const question = await demo.api.startQuestion('t', {
      parentId: '',
      text: 'Please fail',
      context: main,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses(events)).toEqual(['streaming', 'failed']);
    expect(script.calls).toHaveLength(0);
    await demo.api.retryQuestion(question.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(script.calls).toHaveLength(1);
    expect(stored(doneNode() ?? '')).toEqual([{ text: 'After retry?', up: 0 }]);
  });

  it('end to end with the default simulator: plan steps are inherited and hidden once asked', async () => {
    const { demo } = makeDemo();
    const events = record(demo);
    const ask = async (parentId: string, text: string) => {
      const { id } = await demo.api.startQuestion('t', { parentId, text, context: main });
      await vi.runAllTimersAsync();
      const done = events.find(
        (e) =>
          e.event === 'question' && e.data.question.id === id && e.data.question.status === 'done',
      );
      if (done?.event !== 'question' || done.data.question.status !== 'done') throw new Error(id);
      return done.data.question.nodeId;
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
    expect(stored?.filter((item) => item.up > 0)).toEqual([
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
