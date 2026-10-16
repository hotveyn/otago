import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type StoredSuggestion, serializeNodeFile } from '../src/storage/index.js';
import {
  deferred,
  expectDone,
  type FakeAgentOptions,
  fakeAgent,
  makeApp,
  postQuestion,
  TEST_MODELS,
  type TestContext,
  waitFor,
} from './helpers.js';

describe('suggestions API', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  const treeDir = () => path.join(ctx.treesDir, 'rust');
  let clock = 0;

  async function setup(options: FakeAgentOptions = {}) {
    const agent = fakeAgent(options);
    ctx = await makeApp(agent, TEST_MODELS);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    return agent;
  }

  /** Hand-written node (no question flow). `suggestions` undefined = no own list. */
  async function writeNode(
    id: string,
    user: string,
    suggestions?: StoredSuggestion[],
    assistant = `answer to ${user}`,
  ) {
    const dir = path.join(treeDir(), ...id.split('/'));
    await mkdir(dir, { recursive: true });
    clock++;
    const created = new Date(Date.UTC(2026, 9, 15, 10, 0, clock)).toISOString();
    await writeFile(
      path.join(dir, 'node.md'),
      serializeNodeFile({
        created,
        model: 'm',
        user,
        assistant,
        ...(suggestions ? { suggestions } : {}),
      }),
    );
  }

  const get = (node: string, tree = 'rust') =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/trees/${tree}/suggestions?node=${encodeURIComponent(node)}`,
    });
  const structural = (action: string, payload: object) =>
    ctx.app.inject({ method: 'POST', url: `/api/trees/rust/nodes/${action}`, payload });

  describe('GET', () => {
    it('a top-level map: the whole item targets the root; unknown kinds are not sent', async () => {
      await setup();
      await writeNode('map', 'Chapter?', [
        { text: 'A', up: 0 },
        { text: 'B', up: 0 },
        { text: 'W', up: 1, kind: 'whole' },
      ]);
      const dir = path.join(treeDir(), 'odd');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'node.md'),
        [
          '---',
          'created: 2026-10-15T09:00:00.000Z',
          'model: m',
          'suggestions: [{"text":"A","up":0},{"text":"X","up":0,"kind":"extra"},{"text":"W","up":1,"kind":"whole"}]',
          '---',
          '<!-- otago:user -->',
          'Odd?',
          '',
          '<!-- otago:assistant -->',
          'Odd answer.',
          '',
        ].join('\n'),
      );
      const res = await get('map');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        node: 'map',
        state: 'ready',
        suggestions: [
          { text: 'A', target: 'map', up: 0 },
          { text: 'B', target: 'map', up: 0 },
          { text: 'W', target: '', up: 1, kind: 'whole' },
        ],
      });
      expect((await get('odd')).json().suggestions).toEqual([
        { text: 'A', target: 'odd', up: 0 },
        { text: 'W', target: '', up: 1, kind: 'whole' },
      ]);
    });

    it('ready [] for a legacy node without stored ancestors and for a stored empty list', async () => {
      await setup();
      await writeNode('old', 'Q');
      await writeNode('old/older', 'Q1');
      await writeNode('empty', 'Q2', []);
      const legacy = await get('old');
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toEqual({ node: 'old', state: 'ready', suggestions: [] });
      expect((await get('old/older')).json()).toEqual({
        node: 'old/older',
        state: 'ready',
        suggestions: [],
      });
      expect((await get('empty')).json()).toEqual({
        node: 'empty',
        state: 'ready',
        suggestions: [],
      });
    });

    it("a legacy node shows its nearest stored ancestor's items (shifted up); [] stops it", async () => {
      await setup();
      await writeNode('plan', 'Plan?', [
        { text: 'Глава 2', up: 0 },
        { text: 'Глава 3', up: 0 },
      ]);
      await writeNode('plan/legacy', 'Something');
      await writeNode('plan/legacy/deeper', 'More');
      await writeNode('plan/ch2', 'Глава 2');
      await writeNode('plan/empty', 'Nothing', []);
      await writeNode('plan/empty/below', 'Below');
      // `Глава 2` is used (a live child of `plan` asks it).
      expect((await get('plan/legacy')).json()).toEqual({
        node: 'plan/legacy',
        state: 'ready',
        suggestions: [{ text: 'Глава 3', target: 'plan', up: 1 }],
      });
      expect((await get('plan/legacy/deeper')).json().suggestions).toEqual([
        { text: 'Глава 3', target: 'plan', up: 2 },
      ]);
      expect((await get('plan/empty')).json().suggestions).toEqual([]);
      expect((await get('plan/empty/below')).json().suggestions).toEqual([]);
    });

    it('is not capped', async () => {
      await setup();
      const items = Array.from({ length: 7 }, (_, i) => ({ text: `Item ${i}`, up: 0 }));
      await writeNode('many', 'Q', items);
      expect((await get('many')).json().suggestions).toHaveLength(7);
    });

    it('resolves own and inherited items over a 3-level chain', async () => {
      await setup();
      await writeNode('plan', 'Plan?', [
        { text: 'Глава 2', up: 0 },
        { text: 'Глава 3', up: 0 },
      ]);
      await writeNode('plan/глава-1', 'Глава 1', [
        { text: 'Deeper', up: 0 },
        { text: 'Глава 2', up: 1 },
      ]);
      await writeNode('plan/глава-1/deep', 'Deep dive', [
        { text: 'Own', up: 0 },
        { text: 'Deeper', up: 1 },
        { text: 'Глава 3', up: 2 },
        // `глава-1` only inherits it: an item pointing there is dropped.
        { text: 'Глава 2', up: 1 },
        // Would point above the top-level node.
        { text: 'Root', up: 3 },
      ]);
      const res = await get('plan/глава-1/deep');
      expect(res.json()).toEqual({
        node: 'plan/глава-1/deep',
        state: 'ready',
        suggestions: [
          { text: 'Own', target: 'plan/глава-1/deep', up: 0 },
          { text: 'Deeper', target: 'plan/глава-1', up: 1 },
          { text: 'Глава 3', target: 'plan', up: 2 },
        ],
      });
      expect((await get('plan/глава-1')).json().suggestions).toEqual([
        { text: 'Deeper', target: 'plan/глава-1', up: 0 },
        { text: 'Глава 2', target: 'plan', up: 1 },
      ]);
      // Asking `Deeper` under `глава-1` makes it used everywhere it targets `глава-1`.
      await writeNode('plan/глава-1/deeper', 'Deeper');
      expect((await get('plan/глава-1/deep')).json().suggestions).toHaveLength(2);
    });

    it('normalizes the node id to NFC', async () => {
      await setup();
      await writeNode('й', 'Q', [{ text: 'Next', up: 0 }]);
      const res = await get('й'.normalize('NFD'));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        node: 'й',
        state: 'ready',
        suggestions: [{ text: 'Next', target: 'й', up: 0 }],
      });
    });

    it('400 for the tree root, bad ids and a missing param; 404 for unknown tree or node', async () => {
      await setup();
      await writeNode('a', 'Q', []);
      const root = await get('');
      expect(root.statusCode).toBe(400);
      expect(root.json().error).toBe('The tree root has no suggestions');
      expect((await get('a/../b')).statusCode).toBe(400);
      expect((await get('Bad Name')).json().error).toMatch(/Invalid node id/);
      expect(
        (await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/suggestions' })).statusCode,
      ).toBe(400);
      const tree = await get('a', 'nope');
      expect(tree.statusCode).toBe(404);
      expect(tree.json().code).toBe('tree_not_found');
      const node = await get('b');
      expect(node.statusCode).toBe(404);
      expect(node.json().code).toBe('node_not_found');
    });

    it('hides items a live child of the target already asks; soft-deleted children do not count', async () => {
      await setup();
      await writeNode('plan', 'Plan?', [
        { text: 'Глава 2', up: 0 },
        { text: 'Глава 3', up: 0 },
        { text: 'Глава 4', up: 0 },
      ]);
      await writeNode('plan/one', 'Глава 1', [
        { text: 'Глава 2', up: 1 },
        { text: 'Глава 3', up: 1 },
        { text: 'Глава 4', up: 1 },
      ]);
      expect((await get('plan/one')).json().suggestions).toHaveLength(3);
      await writeNode('plan/two', '  Глава 2 \n');
      await writeNode('plan/three', 'Глава 3'.normalize('NFD'));
      await writeNode('plan/four.deleted-1792000000000', 'Глава 4');
      expect((await get('plan/one')).json().suggestions).toEqual([
        { text: 'Глава 4', target: 'plan', up: 1 },
      ]);
    });

    it('drops an inherited item after a move and shows it again after moving back', async () => {
      await setup();
      await writeNode('plan', 'Plan?', [{ text: 'Глава 2', up: 0 }]);
      await writeNode('other', 'Other?', [{ text: 'Something else', up: 0 }]);
      await writeNode('plan/one', 'Глава 1', [
        { text: 'Own', up: 0 },
        { text: 'Глава 2', up: 1 },
      ]);
      expect((await get('plan/one')).json().suggestions).toHaveLength(2);
      expect(
        (await structural('move', { ids: ['plan/one'], targetParentId: 'other' })).statusCode,
      ).toBe(200);
      expect((await get('other/one')).json().suggestions).toEqual([
        { text: 'Own', target: 'other/one', up: 0 },
      ]);
      await structural('move', { ids: ['other/one'], targetParentId: 'plan' });
      expect((await get('plan/one')).json().suggestions).toEqual([
        { text: 'Own', target: 'plan/one', up: 0 },
        { text: 'Глава 2', target: 'plan', up: 1 },
      ]);
    });

    it('the chain payload has no suggestions field', async () => {
      await setup();
      await writeNode('plan', 'Plan?', [{ text: 'Глава 2', up: 0 }]);
      const res = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/chain?node=plan' });
      const [node] = res.json().chain;
      expect(node).toMatchObject({ id: 'plan', user: 'Plan?' });
      expect('suggestions' in node).toBe(false);
    });
  });

  it('POST is gone: 404', async () => {
    await setup();
    await writeNode('a', 'Q');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/suggestions',
      payload: { node: 'a' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('code');
  });

  it('never 409: GET succeeds while a question of the tree streams', async () => {
    const gate = deferred();
    await setup({ gate: () => gate.promise });
    await writeNode('a', 'Q', [{ text: 'Next', up: 0 }]);
    const started = await postQuestion(ctx, { parentId: 'a', text: 'Other' });
    expect(started.statusCode).toBe(202);
    const id = started.json().question.id as string;
    await waitFor(() => ctx.questions.get(id)?.status === 'streaming');
    const res = await get('a');
    expect(res.statusCode).toBe(200);
    expect(res.json().suggestions).toEqual([{ text: 'Next', target: 'a', up: 0 }]);
    gate.open();
    expectDone(await ctx.questions.settled(id));
  });
});
