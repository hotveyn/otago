import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSuggestReply } from '../src/agent/index.js';
import {
  parseNodeFile,
  type StoredSuggestion,
  serializeNodeFile,
  setSuggestionsLine,
} from '../src/storage/index.js';
import {
  deferred,
  type FakeAgentOptions,
  fakeAgent,
  type MakeAppExtra,
  makeApp,
  TEST_MODELS,
  type TestContext,
  waitFor,
} from './helpers.js';

const FAILED_MESSAGE =
  'Could not generate suggestions. They will be retried the next time the node is opened.';

describe('suggestions API', () => {
  let ctx: TestContext;
  afterEach(() => ctx.close());

  const treeDir = () => path.join(ctx.treesDir, 'rust');
  const nodeFile = (id: string) => path.join(treeDir(), ...id.split('/'), 'node.md');
  let clock = 0;

  async function setup(options: FakeAgentOptions = {}, extra: MakeAppExtra = {}) {
    const agent = fakeAgent(options);
    ctx = await makeApp(agent, TEST_MODELS, extra);
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
    return agent;
  }

  /** Hand-written node (no question flow). `suggestions` undefined = missing. */
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
  const post = (node: string, tree = 'rust') =>
    ctx.app.inject({ method: 'POST', url: `/api/trees/${tree}/suggestions`, payload: { node } });
  const structural = (action: string, payload: object) =>
    ctx.app.inject({ method: 'POST', url: `/api/trees/rust/nodes/${action}`, payload });

  describe('GET', () => {
    it('missing for an old node, ready [] for a stored empty list', async () => {
      await setup();
      await writeNode('old', 'Q');
      await writeNode('empty', 'Q2', []);
      const missing = await get('old');
      expect(missing.statusCode).toBe(200);
      expect(missing.json()).toEqual({ node: 'old', state: 'missing', suggestions: [] });
      expect((await get('empty')).json()).toEqual({
        node: 'empty',
        state: 'ready',
        suggestions: [],
      });
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
      expect((await post('')).statusCode).toBe(400);
      expect((await post('b')).json().code).toBe('node_not_found');
      expect((await post('a', 'nope')).json().code).toBe('tree_not_found');
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

  describe('POST', () => {
    it('generates once, splices only the line into node.md and returns ready', async () => {
      const agent = await setup({ suggest: [{ text: 'What next?' }, { text: 'Q' }] });
      await writeNode('a', 'Q');
      const before = await readFile(nodeFile('a'), 'utf8');
      const res = await post('a');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        node: 'a',
        state: 'ready',
        suggestions: [{ text: 'What next?', target: 'a', up: 0 }],
      });
      expect(await readFile(nodeFile('a'), 'utf8')).toBe(
        setSuggestionsLine(before, [{ text: 'What next?', up: 0 }]),
      );
      expect(agent.suggestCalls).toHaveLength(1);
      expect(agent.suggestCalls[0]).toMatchObject({
        ancestors: [],
        current: { id: 'a', user: 'Q', assistant: 'answer to Q' },
        candidates: [],
        model: TEST_MODELS.suggest,
      });
      expect((await post('a')).json()).toEqual(res.json());
      expect(agent.suggestCalls).toHaveLength(1);
      expect((await get('a')).json()).toEqual(res.json());
    });

    it('offers the nearest stored ancestor as candidates and stores keeps relative', async () => {
      const agent = await setup({ suggest: [{ keep: 0 }, { text: 'Own' }] });
      await writeNode('plan', 'Plan?', [
        { text: 'Глава 1', up: 0 },
        { text: 'Глава 2', up: 0 },
      ]);
      await writeNode('plan/one', 'Глава 1');
      const res = await post('plan/one');
      expect(agent.suggestCalls[0]?.candidates).toEqual([
        { text: 'Глава 2', source: 'plan', origin: 0 },
      ]);
      expect(agent.suggestCalls[0]?.ancestors).toEqual([
        { id: 'plan', user: 'Plan?', assistant: 'answer to Plan?' },
      ]);
      expect(res.json().suggestions).toEqual([
        { text: 'Own', target: 'plan/one', up: 0 },
        { text: 'Глава 2', target: 'plan', up: 1 },
      ]);
      expect(parseNodeFile(await readFile(nodeFile('plan/one'), 'utf8')).suggestions).toEqual([
        { text: 'Own', up: 0 },
        { text: 'Глава 2', up: 1 },
      ]);
    });

    it('dedupes concurrent requests into one generation', async () => {
      const gate = deferred();
      const agent = await setup({ suggest: [{ text: 'Next' }], suggestGate: () => gate.promise });
      await writeNode('a', 'Q');
      const first = post('a');
      const second = post('a');
      await waitFor(() => agent.suggestCalls.length === 1);
      expect((await get('a')).json().state).toBe('missing');
      const third = post('a');
      gate.open();
      const responses = await Promise.all([first, second, third]);
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.json().suggestions).toEqual([{ text: 'Next', target: 'a', up: 0 }]);
      }
      expect(agent.suggestCalls).toHaveLength(1);
    });

    it('502 on failure (node stays missing); the next request tries again', async () => {
      let mode: 'throw' | 'garbage' | 'ok' = 'throw';
      const agent = await setup({
        suggest: () => {
          if (mode === 'throw') throw new Error('SDK exploded');
          if (mode === 'garbage') return parseSuggestReply('not json at all', 0);
          return [{ text: 'Next' }];
        },
      });
      await writeNode('a', 'Q');
      const before = await readFile(nodeFile('a'), 'utf8');
      const failed = await post('a');
      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toEqual({ error: FAILED_MESSAGE, code: 'suggestions_failed' });
      mode = 'garbage';
      expect((await post('a')).statusCode).toBe(502);
      expect(await readFile(nodeFile('a'), 'utf8')).toBe(before);
      expect((await get('a')).json().state).toBe('missing');
      mode = 'ok';
      expect((await post('a')).statusCode).toBe(200);
      expect(agent.suggestCalls).toHaveLength(3);
    });

    it('502 when the model call times out', async () => {
      await setup({ suggestGate: () => new Promise(() => undefined) }, { suggestTimeoutMs: 50 });
      await writeNode('a', 'Q');
      const res = await post('a');
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('suggestions_failed');
      expect(parseNodeFile(await readFile(nodeFile('a'), 'utf8')).suggestions).toBeUndefined();
    });

    it('takes no lock: structural routes succeed while a generation runs', async () => {
      const gate = deferred();
      const agent = await setup({ suggest: [{ text: 'Next' }], suggestGate: () => gate.promise });
      await writeNode('a', 'Q');
      await writeNode('b', 'Q2');
      await writeNode('c', 'Q3');
      await writeNode('target', 'T', []);
      const pending = post('a');
      await waitFor(() => agent.suggestCalls.length === 1);
      expect((await structural('move', { ids: ['b'], targetParentId: 'target' })).statusCode).toBe(
        200,
      );
      expect((await structural('rename', { id: 'target', name: 'renamed' })).statusCode).toBe(200);
      const deleted = await structural('delete', { ids: ['c'] });
      expect(deleted.statusCode).toBe(200);
      const trashId = deleted.json().deleted.c as string;
      expect((await structural('restore', { trashIds: [trashId] })).statusCode).toBe(200);
      const title = await ctx.app.inject({
        method: 'PATCH',
        url: '/api/trees/rust',
        payload: { title: 'Go' },
      });
      expect(title.statusCode).toBe(200);
      gate.open();
      // The tree was renamed meanwhile: nothing is written.
      expect((await pending).json().code).toBe('tree_not_found');
    });

    async function racedStructural(
      act: () => Promise<unknown>,
    ): Promise<{ res: Awaited<ReturnType<typeof post>>; before: string }> {
      const gate = deferred();
      const agent = await setup({ suggest: [{ text: 'Next' }], suggestGate: () => gate.promise });
      await writeNode('a', 'Q');
      await writeNode('b', 'Other', []);
      const before = await readFile(nodeFile('a'), 'utf8');
      const pending = post('a');
      await waitFor(() => agent.suggestCalls.length === 1);
      await act();
      gate.open();
      return { res: await pending, before };
    }

    it('moved during generation → 404, nothing written at either place', async () => {
      const { res, before } = await racedStructural(() =>
        structural('move', { ids: ['a'], targetParentId: 'b' }),
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('node_not_found');
      expect(await readFile(nodeFile('b/a'), 'utf8')).toBe(before);
      await expect(stat(path.join(treeDir(), 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('renamed during generation → 404, nothing written', async () => {
      const { res, before } = await racedStructural(() =>
        structural('rename', { id: 'a', name: 'new-name' }),
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('node_not_found');
      expect(await readFile(nodeFile('new-name'), 'utf8')).toBe(before);
    });

    it('deleted during generation → 404, the trash copy is unchanged, no folder recreated', async () => {
      let trashId = '';
      const { res, before } = await racedStructural(async () => {
        const deleted = await structural('delete', { ids: ['a'] });
        trashId = deleted.json().deleted.a;
      });
      expect(res.statusCode).toBe(404);
      expect(await readFile(path.join(treeDir(), trashId, 'node.md'), 'utf8')).toBe(before);
      await expect(stat(path.join(treeDir(), 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('tree renamed during generation → 404 tree_not_found', async () => {
      const { res } = await racedStructural(() =>
        ctx.app.inject({ method: 'PATCH', url: '/api/trees/rust', payload: { title: 'Go' } }),
      );
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('tree_not_found');
      const file = path.join(ctx.treesDir, 'go', 'a', 'node.md');
      expect(parseNodeFile(await readFile(file, 'utf8')).suggestions).toBeUndefined();
    });

    it('moved away and back during generation → written', async () => {
      const { res } = await racedStructural(async () => {
        await structural('move', { ids: ['a'], targetParentId: 'b' });
        await structural('move', { ids: ['b/a'], targetParentId: '' });
      });
      expect(res.statusCode).toBe(200);
      expect(parseNodeFile(await readFile(nodeFile('a'), 'utf8')).suggestions).toEqual([
        { text: 'Next', up: 0 },
      ]);
    });

    it('file changed during generation → 502, nothing written', async () => {
      let changed = '';
      const { res } = await racedStructural(async () => {
        changed = (await readFile(nodeFile('a'), 'utf8')).replace('answer to Q', 'edited');
        await writeFile(nodeFile('a'), changed);
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().code).toBe('suggestions_failed');
      expect(await readFile(nodeFile('a'), 'utf8')).toBe(changed);
    });

    it('another writer stored a list meanwhile → 200 with the stored list', async () => {
      const { res } = await racedStructural(async () => {
        const text = await readFile(nodeFile('a'), 'utf8');
        await writeFile(nodeFile('a'), setSuggestionsLine(text, [{ text: 'Theirs', up: 0 }]));
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().suggestions).toEqual([{ text: 'Theirs', target: 'a', up: 0 }]);
    });

    it('app close aborts a running generation; nothing is written afterwards', async () => {
      const gate = deferred();
      let signal: AbortSignal | undefined;
      const agent = await setup({
        suggest: [{ text: 'Next' }],
        suggestGate: (input) => {
          signal = input.signal;
          return gate.promise;
        },
      });
      await writeNode('a', 'Q');
      const before = await readFile(nodeFile('a'), 'utf8');
      const pending = post('a');
      await waitFor(() => agent.suggestCalls.length === 1);
      await ctx.suggestions.close();
      expect(signal?.aborted).toBe(true);
      gate.open();
      expect((await pending).statusCode).toBe(502);
      expect(await readFile(nodeFile('a'), 'utf8')).toBe(before);
      // Closed: no new generation starts either.
      expect((await post('a')).statusCode).toBe(502);
      expect(agent.suggestCalls).toHaveLength(1);
    });
  });
});
