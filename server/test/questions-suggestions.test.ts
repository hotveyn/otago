import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AgentEvent, AskInput, NameInput } from '../src/agent/index.js';
import { fallbackNodeName } from '../src/agent/index.js';
import type { QuestionLogger, QuestionTimings } from '../src/questions/index.js';
import {
  parseNodeFile,
  type StoredSuggestion,
  SUGGESTIONS_MARKER,
  serializeNodeFile,
  suggestionBlock,
  wholeItem,
} from '../src/storage/index.js';
import {
  askAndSettle,
  deferred,
  expectDone,
  expectFailed,
  type FakeAgent,
  makeApp,
  multipartMessage,
  openEventStream,
  postQuestion,
  raceAbort,
  settle,
  TEST_MODELS,
  type TestContext,
  waitFor,
} from './helpers.js';

const M = SUGGESTIONS_MARKER;

interface ScriptOptions {
  /** Chunks of call `call` (0-based) for `input`. */
  chunks: (input: AskInput, call: number) => string[];
  /** Awaited before chunk `index` of call `call` when it returns a promise (raced with abort). */
  gate?: (index: number, call: number) => Promise<void> | undefined;
  /** Throws before chunk `index` of call `call` when it returns true. */
  failAt?: (index: number, call: number) => boolean;
}

/** Agent with scripted chunks per call; nodes are named after their question. */
function scriptedAgent(options: ScriptOptions): FakeAgent {
  const calls: AskInput[] = [];
  const nameCalls: NameInput[] = [];
  return {
    calls,
    nameCalls,
    async *ask(input): AsyncGenerator<AgentEvent> {
      const call = calls.length;
      calls.push(input);
      const chunks = options.chunks(input, call);
      let text = '';
      for (const [index, chunk] of chunks.entries()) {
        if (options.failAt?.(index, call)) throw new Error('Agent exploded');
        const gate = options.gate?.(index, call);
        if (gate) await raceAbort(gate, input.signal);
        if (input.signal.aborted) throw new Error('Aborted');
        text += chunk;
        yield { type: 'chunk', text: chunk };
      }
      if (options.failAt?.(chunks.length, call)) throw new Error('Agent exploded');
      yield { type: 'done', text: text.trim(), model: input.model };
    },
    async name(input) {
      nameCalls.push(input);
      return fallbackNodeName(input.question);
    },
  };
}

/** The same chunks for every call. */
const always = (...chunks: string[]) => scriptedAgent({ chunks: () => chunks });

describe('suggestion blocks of answers', () => {
  let ctx: TestContext;
  let warn: Mock<QuestionLogger['warn']>;
  afterEach(() => ctx.close());

  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const nodeFile = (id: string) => path.join(treeDir(), ...id.split('/'), 'node.md');
  const readNode = async (id: string) => parseNodeFile(await readFile(nodeFile(id), 'utf8'));
  const treeEntries = async () => (await readdir(treeDir())).sort();
  const getSuggestions = async (node: string) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/trees/rust/suggestions?node=${encodeURIComponent(node)}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json().suggestions;
  };
  let clock = 0;

  async function setup(agent: FakeAgent, timings?: Partial<QuestionTimings>) {
    warn = vi.fn<QuestionLogger['warn']>();
    ctx = await makeApp(agent, TEST_MODELS, { timings, log: { warn, error: vi.fn() } });
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    return agent;
  }

  /** Hand-written node (no question flow). `suggestions` undefined = no own list. */
  async function writeNode(id: string, user: string, suggestions?: StoredSuggestion[]) {
    const dir = path.join(treeDir(), ...id.split('/'));
    await mkdir(dir, { recursive: true });
    clock++;
    await writeFile(
      path.join(dir, 'node.md'),
      serializeNodeFile({
        created: new Date(Date.UTC(2026, 9, 15, 10, 0, clock)).toISOString(),
        model: 'm',
        user,
        assistant: `answer to ${user}`,
        ...(suggestions ? { suggestions } : {}),
      }),
    );
  }

  /** Chunk events of `id` have contiguous offsets per attempt. */
  function expectContiguous(id: string) {
    const next = new Map<number, number>();
    for (const event of ctx.events.forQuestion(id)) {
      if (event.event !== 'chunk') continue;
      const { attempt, offset, text } = event.data;
      expect(offset).toBe(next.get(attempt) ?? 0);
      next.set(attempt, offset + text.length);
    }
  }

  it('strips the block from the saved answer, the chunks and the naming input', async () => {
    const agent = await setup(always('Answer text.', suggestionBlock(['What next?'])));
    const { question, started } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    const done = expectDone(question);
    const node = await readNode(done.nodeId);
    expect(node.assistant).toBe('Answer text.');
    expect(node.suggestions).toEqual([{ text: 'What next?', up: 0 }]);
    expect(agent.nameCalls[0]?.answer).toBe('Answer text.');
    // The stream ends right before the marker line (display only; the node has the trimmed text).
    expect(ctx.events.text(started.id)).toBe('Answer text.\n\n');
    expectContiguous(started.id);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never sends a marker split across chunks', async () => {
    const full = `Answer.${suggestionBlock(['a', 'b'])}`;
    const offsets = [8, 9, 10, 11, 14, 20, 30, 35, 36, full.length - 2];
    let split = 0;
    await setup(
      scriptedAgent({
        chunks: () => {
          const at = offsets[split++] ?? 0;
          return [full.slice(0, at), full.slice(at)];
        },
      }),
    );
    for (const [index] of offsets.entries()) {
      const { question, started } = await askAndSettle(ctx, { parentId: '', text: `Q ${index}` });
      const done = expectDone(question);
      expect(ctx.events.text(started.id)).toBe('Answer.\n\n');
      expect((await readNode(done.nodeId)).suggestions).toEqual([
        { text: 'a', up: 0 },
        { text: 'b', up: 0 },
      ]);
    }
  });

  it('snapshots taken during the block never contain it; offsets stay contiguous', async () => {
    const gate = deferred();
    await setup(
      scriptedAgent({
        chunks: () => ['Answer.', `\n\n${M}\n`, '- Next\n', 'More prose.'],
        gate: (index) => (index === 2 ? gate.promise : undefined),
      }),
    );
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const res = await postQuestion(ctx, { parentId: '', text: 'Q' });
    const id = res.json().question.id as string;
    await waitFor(() => ctx.events.forQuestion(id).filter((e) => e.event === 'chunk').length > 0);
    // The marker chunk went through the filter (and was held).
    await waitFor(() => ctx.questions.detail(id)?.live?.answer === 'Answer.\n\n');
    const subscription = ctx.questions.subscribe({ onEvent: () => {}, onEnd: () => {} });
    const entry = subscription.snapshot.questions.find((question) => question.id === id);
    subscription.unsubscribe();
    expect(entry?.live?.answer).toBe('Answer.\n\n');
    const stream = await openEventStream(baseUrl);
    const snapshot = await stream.next((frame) => frame.event === 'snapshot');
    expect(JSON.stringify(snapshot.data)).not.toContain('otago:suggestions');
    stream.close();

    gate.open();
    const done = expectDone(await ctx.questions.settled(id));
    // The block was broken by prose: everything is released, in order.
    expect(ctx.events.text(id)).toBe(`Answer.\n\n${M}\n- Next\nMore prose.`);
    expectContiguous(id);
    const node = await readNode(done.nodeId);
    expect(node.assistant).toBe(`Answer.\n\n${M}\n- Next\nMore prose.`);
    expect(node.suggestions).toBeUndefined();
  });

  it('no block: no key, and the new node shows the parent list with up 1', async () => {
    await setup(always('Plain answer.'));
    await writeNode('plan', 'Plan?', [{ text: 'Глава 2', up: 0 }]);
    const done = expectDone(
      (await askAndSettle(ctx, { parentId: 'plan', text: 'Term?' })).question,
    );
    const raw = await readFile(nodeFile(done.nodeId), 'utf8');
    expect(raw).not.toContain('suggestions');
    expect(await getSuggestions(done.nodeId)).toEqual([{ text: 'Глава 2', target: 'plan', up: 1 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an empty block stores [] and stops inheritance', async () => {
    await setup(always('Answer.', suggestionBlock([])));
    await writeNode('plan', 'Plan?', [{ text: 'Глава 2', up: 0 }]);
    const done = expectDone(
      (await askAndSettle(ctx, { parentId: 'plan', text: 'Term?' })).question,
    );
    expect((await readNode(done.nodeId)).suggestions).toEqual([]);
    expect(await getSuggestions(done.nodeId)).toEqual([]);
  });

  it('a rejected marker stays in the answer, stores no key and logs one warning', async () => {
    const text = `Answer\n${M}\n- x\nMore prose.`;
    await setup(always(text));
    const done = expectDone((await askAndSettle(ctx, { parentId: '', text: 'Q' })).question);
    const node = await readNode(done.nodeId);
    expect(node.assistant).toBe(text);
    expect(node.suggestions).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a marker inside a fence is plain answer text (no key, no warning)', async () => {
    const text = `Example:\n\n\`\`\`md\n${M}\n- x\n\`\`\``;
    await setup(always(text));
    const { question, started } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    const node = await readNode(expectDone(question).nodeId);
    expect(node.assistant).toBe(text);
    expect(node.suggestions).toBeUndefined();
    expect(ctx.events.text(started.id)).toBe(text);
    expect(warn).not.toHaveBeenCalled();
  });

  it("offers the parent's open suggestions to the agent", async () => {
    const agent = await setup(always('Answer.'));
    await writeNode('plan', 'Plan?', [
      { text: 'A', up: 0 },
      { text: 'B', up: 0 },
      { text: 'C', up: 0 },
    ]);
    await writeNode('plan/b', 'B');
    await askAndSettle(ctx, { parentId: 'plan', text: 'Side' });
    expect(agent.calls[0]?.openSuggestions).toEqual(['A', 'C']);

    // A legacy parent without a list passes the grandparent's list.
    await writeNode('g', 'G?', [{ text: 'X', up: 0 }]);
    await writeNode('g/p', 'P?');
    await askAndSettle(ctx, { parentId: 'g/p', text: 'Child' });
    expect(agent.calls[1]?.openSuggestions).toEqual(['X']);

    await askAndSettle(ctx, { parentId: '', text: 'Top' });
    expect(agent.calls[2]?.openSuggestions).toEqual([]);
  });

  it('a copied candidate is stored as a keep pointing at its owner (two levels too)', async () => {
    await setup(always('Answer.', suggestionBlock(['Глава 2'])));
    await writeNode('plan', 'Plan?', [{ text: 'Глава 2', up: 0 }]);
    const child = expectDone(
      (await askAndSettle(ctx, { parentId: 'plan', text: 'Term?' })).question,
    );
    expect((await readNode(child.nodeId)).suggestions).toEqual([{ text: 'Глава 2', up: 1 }]);
    expect(await getSuggestions(child.nodeId)).toEqual([
      { text: 'Глава 2', target: 'plan', up: 1 },
    ]);

    const grandchild = expectDone(
      (await askAndSettle(ctx, { parentId: child.nodeId, text: 'Deeper?' })).question,
    );
    expect((await readNode(grandchild.nodeId)).suggestions).toEqual([{ text: 'Глава 2', up: 2 }]);
    expect(await getSuggestions(grandchild.nodeId)).toEqual([
      { text: 'Глава 2', target: 'plan', up: 2 },
    ]);
  });

  it('an item asked by hand is no longer offered and is hidden', async () => {
    const agent = await setup(always('Answer.'));
    await writeNode('plan', 'Plan?', [
      { text: 'Глава 2', up: 0 },
      { text: 'Глава 3', up: 0 },
    ]);
    await askAndSettle(ctx, { parentId: 'plan', text: 'Глава 2' });
    expect(agent.calls[0]?.openSuggestions).toEqual(['Глава 3']);
    await askAndSettle(ctx, { parentId: 'plan', text: 'Other' });
    expect(agent.calls[1]?.openSuggestions).toEqual(['Глава 3']);
    expect(await getSuggestions('plan')).toEqual([{ text: 'Глава 3', target: 'plan', up: 0 }]);
  });

  it('finalizes the block: asked, duplicate and empty items dropped, edits own, no cap', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `Item ${i}`);
    await setup(
      always(
        'Answer.',
        suggestionBlock(['Ask me', 'Глава 2', 'Глава 2, but shorter', ...many, ' Item 1 ', '']),
      ),
    );
    await writeNode('plan', 'Plan?', [{ text: 'Глава 2', up: 0 }]);
    const done = expectDone(
      (await askAndSettle(ctx, { parentId: 'plan', text: 'Ask me' })).question,
    );
    expect((await readNode(done.nodeId)).suggestions).toEqual([
      { text: 'Глава 2, but shorter', up: 0 },
      ...many.map((text) => ({ text, up: 0 })),
      { text: 'Глава 2', up: 1 },
    ]);
    expect(await getSuggestions(done.nodeId)).toHaveLength(12);
  });

  it('cancel during the block: no node, no block in any chunk', async () => {
    const gate = deferred();
    await setup(
      scriptedAgent({
        chunks: () => ['Answer.', `\n\n${M}\n`, '- Next'],
        gate: (index) => (index === 2 ? gate.promise : undefined),
      }),
    );
    const res = await postQuestion(ctx, { parentId: '', text: 'Q' });
    const id = res.json().question.id as string;
    await waitFor(() => ctx.questions.detail(id)?.live?.answer === 'Answer.\n\n');
    await ctx.app.inject({ method: 'DELETE', url: `/api/questions/${id}` });
    expect(await ctx.questions.settled(id)).toBeUndefined();
    expect(ctx.events.text(id)).toBe('Answer.\n\n');
    expect(await treeEntries()).toEqual(['tree.md']);
  });

  it('a failure inside the block keeps it out of live text; the retry stores its own block', async () => {
    const agent = await setup(
      scriptedAgent({
        chunks: (_input, call) =>
          call === 0
            ? ['Answer 1.', `\n\n${M}\n`, '- First', '\n- More']
            : ['Answer 2.', suggestionBlock(['Second'])],
        failAt: (index, call) => call === 0 && index === 3,
      }),
    );
    const first = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    const failed = expectFailed(first.question);
    expect(failed.error.code).toBe('agent_error');
    expect(ctx.questions.detail(failed.id)?.live?.answer).toBe('Answer 1.\n\n');

    const res = await ctx.app.inject({ method: 'POST', url: `/api/questions/${failed.id}/retry` });
    expect(res.statusCode).toBe(202);
    const done = expectDone(await ctx.questions.settled(failed.id));
    expect(agent.calls).toHaveLength(2);
    const node = await readNode(done.nodeId);
    expect(node.assistant).toBe('Answer 2.');
    expect(node.suggestions).toEqual([{ text: 'Second', up: 0 }]);
    expect(ctx.events.text(failed.id)).not.toContain('<!--');
  });

  it('an attempt timeout mid-block fails with timeout and leaks no block', async () => {
    await setup(
      scriptedAgent({
        chunks: () => ['Answer.', `\n\n${M}\n`, '- Next'],
        gate: (index) => (index === 2 ? new Promise(() => {}) : undefined),
      }),
      { attemptTimeoutMs: 50 },
    );
    const { question, started } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    expect(expectFailed(question).error.code).toBe('timeout');
    expect(ctx.events.text(started.id)).not.toContain('<!--');
    expect(ctx.questions.detail(started.id)?.live?.answer).toBe('Answer.\n\n');
    expect(await treeEntries()).toEqual(['tree.md']);
  });

  it('an answer that is only a block fails as an empty answer', async () => {
    await setup(always(`${M}\n- x`));
    const { question } = await askAndSettle(ctx, { parentId: '', text: 'Q' });
    const failed = expectFailed(question);
    expect(failed.error).toMatchObject({
      code: 'agent_error',
      message: 'Agent returned an empty answer',
    });
    expect(await treeEntries()).toEqual(['tree.md']);
  });

  it('a files-only message with a block stores the items', async () => {
    await setup(always('Answer.', suggestionBlock(['Next'])));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/questions',
      ...multipartMessage({ parentId: '', text: '' }, [{ name: 'notes.md', content: 'abc' }]),
    });
    const done = expectDone((await settle(ctx, res)).question);
    const node = await readNode(done.nodeId);
    expect(node.user).toBe('');
    expect(node.suggestions).toEqual([{ text: 'Next', up: 0 }]);
  });

  describe('topic split: map with a whole item', () => {
    const MAP = 'The topic is big. Map:\n\n- Part one\n- Part two\n- Part three';
    const PARTS = ['Part one', 'Part two', 'Part three'];
    const WHOLE = 'Whole chapter in one answer';
    const mapBlock = suggestionBlock([...PARTS, wholeItem(WHOLE)]);

    /** Call 0 answers with the map; every later call with a plain answer. */
    const mapAgent = () =>
      scriptedAgent({
        chunks: (_input, call) => (call === 0 ? [MAP, mapBlock] : ['Part answer.']),
      });

    it('S1–S3: stores the map, offers its parts, hides used items and the whole item', async () => {
      const agent = await setup(mapAgent());
      const { question, started } = await askAndSettle(ctx, {
        parentId: '',
        text: 'Explain chapter four',
      });
      const map = expectDone(question).nodeId;
      const node = await readNode(map);
      expect(node.assistant).toBe(MAP);
      expect(node.suggestions).toEqual([
        ...PARTS.map((text) => ({ text, up: 0 })),
        { text: WHOLE, up: 1, kind: 'whole' },
      ]);
      const raw = await readFile(nodeFile(map), 'utf8');
      expect(raw).toContain(`{"text":"${WHOLE}","up":1,"kind":"whole"}`);
      for (const event of ctx.events.forQuestion(started.id)) {
        if (event.event !== 'chunk') continue;
        expect(event.data.text).not.toContain('otago');
        expect(event.data.text).not.toContain(WHOLE);
      }
      expect(ctx.events.text(started.id)).toBe(`${MAP}\n\n`);
      const live = ctx.questions.detail(started.id)?.live?.answer;
      expect(live ?? '').not.toContain('otago');
      expect(agent.nameCalls[0]?.answer).toBe(MAP);
      expect(await getSuggestions(map)).toEqual([
        ...PARTS.map((text) => ({ text, target: map, up: 0 })),
        { text: WHOLE, target: '', up: 1, kind: 'whole' },
      ]);

      // S2: a part asked from the map.
      const part = expectDone(
        (await askAndSettle(ctx, { parentId: map, text: 'Part one' })).question,
      ).nodeId;
      expect(agent.calls[1]?.openSuggestions).toEqual(['Part two', 'Part three']);
      expect(await getSuggestions(part)).toEqual([
        { text: 'Part two', target: map, up: 1 },
        { text: 'Part three', target: map, up: 1 },
      ]);
      expect(await getSuggestions(map)).toEqual([
        { text: 'Part two', target: map, up: 0 },
        { text: 'Part three', target: map, up: 0 },
        { text: WHOLE, target: '', up: 1, kind: 'whole' },
      ]);
      // The next part under the map: the whole text is never a candidate.
      await askAndSettle(ctx, { parentId: map, text: 'Something else' });
      expect(agent.calls[2]?.openSuggestions).toEqual(['Part two', 'Part three']);

      // S3: explain it whole, a sibling of the map.
      const whole = expectDone(
        (await askAndSettle(ctx, { parentId: '', text: WHOLE })).question,
      ).nodeId;
      expect(whole.includes('/')).toBe(false);
      expect(await getSuggestions(map)).toEqual([
        { text: 'Part two', target: map, up: 0 },
        { text: 'Part three', target: map, up: 0 },
      ]);
    });

    it('a nested map: the whole item targets its parent and follows a move', async () => {
      await setup(always('Answer.'));
      await writeNode('p', 'P?');
      await writeNode('other', 'Other?');
      await writeNode('p/map', 'Map?', [
        { text: 'A', up: 0 },
        { text: 'B', up: 0 },
        { text: 'W', up: 1, kind: 'whole' },
      ]);
      expect((await getSuggestions('p/map')).at(-1)).toEqual({
        text: 'W',
        target: 'p',
        up: 1,
        kind: 'whole',
      });
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/trees/rust/nodes/move',
        payload: { ids: ['p/map'], targetParentId: 'other' },
      });
      expect(res.statusCode).toBe(200);
      expect((await getSuggestions('other/map')).at(-1)).toEqual({
        text: 'W',
        target: 'other',
        up: 1,
        kind: 'whole',
      });
    });

    it('a whole item without a split is dropped', async () => {
      await setup(always('Answer.', suggestionBlock(['Only one', wholeItem(WHOLE)])));
      const done = expectDone((await askAndSettle(ctx, { parentId: '', text: 'Q' })).question);
      expect((await readNode(done.nodeId)).suggestions).toEqual([{ text: 'Only one', up: 0 }]);
    });

    it('cancel inside a block with a whole item: no node, no whole line in any chunk', async () => {
      const gate = deferred();
      let reached = false;
      await setup(
        scriptedAgent({
          chunks: () => ['Answer.', `\n\n${M}\n`, '- A\n', `- ${wholeItem(WHOLE)}\n`, '- B'],
          gate: (index) => {
            if (index !== 4) return undefined;
            reached = true;
            return gate.promise;
          },
        }),
      );
      const res = await postQuestion(ctx, { parentId: '', text: 'Q' });
      const id = res.json().question.id as string;
      await waitFor(() => reached);
      expect(ctx.questions.detail(id)?.live?.answer).toBe('Answer.\n\n');
      await ctx.app.inject({ method: 'DELETE', url: `/api/questions/${id}` });
      expect(await ctx.questions.settled(id)).toBeUndefined();
      expect(ctx.events.text(id)).toBe('Answer.\n\n');
      expect(ctx.events.text(id)).not.toContain('otago:whole');
      expect(await treeEntries()).toEqual(['tree.md']);
    });
  });
});
