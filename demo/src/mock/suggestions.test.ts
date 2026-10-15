import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type StoredSuggestion,
  type SuggestionCandidate,
  setSuggestionsLine,
} from '../../../server/src/storage/suggestions';
import { ApiError } from '../../../web/src/api/client';
import { SUGGESTIONS_FAILED_MESSAGE } from './errors';
import { parseNodeFile } from './format';
import { simulateSuggestions } from './suggestions';
import { makeDemo, NODE, type ScriptStep, SMALL_SEED, scriptedSuggest } from './test-helpers';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const own = (...texts: string[]): StoredSuggestion[] => texts.map((text) => ({ text, up: 0 }));

function setup(extra: Record<string, string> = {}, steps: ScriptStep[] = []) {
  const script = scriptedSuggest(steps);
  const { demo, storage } = makeDemo({
    seed: { ...SMALL_SEED, ...extra },
    suggest: script.simulate,
  });
  const read = (path: string) => demo.vfs.readText(path) ?? '';
  const stored = (path: string) => parseNodeFile(read(path)).suggestions;
  return { demo, storage, script, read, stored };
}

/** A 3-level chain `g` → `g/p` → `g/p/v` with own and inherited items. */
const CHAIN_SEED = {
  't/g/node.md': NODE('G?', at(10), own('G1', 'G2')),
  't/g/p/node.md': NODE('P?', at(11), [
    { text: 'Перейдём к главе 2', up: 0 },
    { text: 'G1', up: 1 },
  ]),
  't/g/p/v/node.md': NODE('V?', at(12), [
    { text: 'V1', up: 0 },
    { text: 'G2', up: 0 },
    { text: 'G2', up: 2 },
    { text: 'Перейдём к главе 2', up: 1 },
    { text: 'G1', up: 2 },
  ]),
};

const CHAIN_VIEW = [
  { text: 'V1', target: 'g/p/v', up: 0 },
  { text: 'G2', target: 'g/p/v', up: 0 },
  { text: 'Перейдём к главе 2', target: 'g/p', up: 1 },
  { text: 'G1', target: 'g', up: 2 },
];

describe('suggestions: GET', () => {
  it('reports missing and stored empty lists', async () => {
    const { demo } = setup({ 't/e/node.md': NODE('E?', at(10), []) });
    expect(await demo.api.getSuggestions('t', 'a')).toEqual({
      node: 'a',
      state: 'missing',
      suggestions: [],
    });
    expect(await demo.api.getSuggestions('t', 'e')).toEqual({
      node: 'e',
      state: 'ready',
      suggestions: [],
    });
  });

  it('resolves own and inherited items along the chain; own wins over a duplicate', async () => {
    const { demo } = setup(CHAIN_SEED);
    expect(await demo.api.getSuggestions('t', 'g/p/v')).toEqual({
      node: 'g/p/v',
      state: 'ready',
      suggestions: CHAIN_VIEW,
    });
  });

  it('hides an item a live child of its target already asks, shows it after a delete', async () => {
    const { demo } = setup(CHAIN_SEED);
    const asked = '  Перейдём к главе 2  '.normalize('NFD');
    expect(asked.trim()).not.toBe('Перейдём к главе 2');
    demo.vfs.transaction(() => demo.vfs.writeText('t/g/p/x/node.md', NODE(asked, at(13))));
    const texts = async () =>
      (await demo.api.getSuggestions('t', 'g/p/v')).suggestions.map((s) => s.text);
    expect(await texts()).toEqual(['V1', 'G2', 'G1']);
    await demo.api.deleteNodes('t', ['g/p/x']);
    expect(await texts()).toEqual(['V1', 'G2', 'Перейдём к главе 2', 'G1']);
  });

  it('drops inherited items after a move and shows them again after moving back', async () => {
    const { demo } = setup(CHAIN_SEED);
    await demo.api.moveNodes('t', ['g/p/v'], 'c');
    expect((await demo.api.getSuggestions('t', 'c/v')).suggestions).toEqual([
      { text: 'V1', target: 'c/v', up: 0 },
      { text: 'G2', target: 'c/v', up: 0 },
    ]);
    await demo.api.moveNodes('t', ['c/v'], 'g/p');
    expect((await demo.api.getSuggestions('t', 'g/p/v')).suggestions).toEqual(CHAIN_VIEW);
  });

  it('validates like the server (GET and POST)', async () => {
    const { demo, script } = setup();
    for (const call of [demo.api.getSuggestions, demo.api.generateSuggestions]) {
      const root = await apiError(call('t', ''));
      expect(root).toMatchObject({ status: 400, message: 'The tree root has no suggestions' });
      expect(await apiError(call('t', 'A B'))).toMatchObject({ status: 400 });
      expect(await apiError(call('t', 'a/files'))).toMatchObject({ status: 400 });
      expect(await apiError(call('t', 'a'.repeat(1001)))).toMatchObject({
        status: 400,
        message: 'Invalid input',
      });
      expect(await apiError(call('nope', 'a'))).toMatchObject({
        status: 404,
        code: 'tree_not_found',
      });
      expect(await apiError(call('t', 'zz'))).toMatchObject({
        status: 404,
        code: 'node_not_found',
      });
    }
    expect(script.calls).toHaveLength(0);
  });

  it('normalizes the node id to NFC', async () => {
    const { demo } = setup({ 't/ёж/node.md': NODE('Ёж?', at(10), own('Next?')) });
    const response = await demo.api.getSuggestions('t', 'ёж'.normalize('NFD'));
    expect(response).toMatchObject({ node: 'ёж', state: 'ready' });
  });
});

describe('suggestions: POST (lazy generation)', () => {
  it('generates once, splices the line into node.md and answers ready', async () => {
    const { demo, script, read } = setup({}, [{ delayMs: 100, picks: [{ text: 'Next one?' }] }]);
    const before = read('t/a/node.md');
    const post = demo.api.generateSuggestions('t', 'a');
    await vi.advanceTimersByTimeAsync(100);
    expect(await post).toEqual({
      node: 'a',
      state: 'ready',
      suggestions: [{ text: 'Next one?', target: 'a', up: 0 }],
    });
    expect(script.calls).toHaveLength(1);
    expect(script.calls[0]?.input).toMatchObject({
      treeId: 't',
      nodeId: 'a',
      ancestors: [],
      current: { user: 'A?', assistant: 'Answer to A?' },
      candidates: [],
    });
    expect(read('t/a/node.md')).toBe(setSuggestionsLine(before, own('Next one?')));
    expect(await demo.api.generateSuggestions('t', 'a')).toMatchObject({ state: 'ready' });
    expect(script.calls).toHaveLength(1);
  });

  it('answers a stored list at once, without a generation', async () => {
    const { demo, script } = setup({ 't/e/node.md': NODE('E?', at(10), []) });
    expect(await demo.api.generateSuggestions('t', 'e')).toEqual({
      node: 'e',
      state: 'ready',
      suggestions: [],
    });
    expect(script.calls).toHaveLength(0);
  });

  it('dedups concurrent requests into one generation', async () => {
    const { demo, script } = setup({}, [{ picks: 'gate' }]);
    const first = demo.api.generateSuggestions('t', 'a');
    const second = demo.api.generateSuggestions('t', 'a');
    expect(await demo.api.getSuggestions('t', 'a')).toMatchObject({ state: 'missing' });
    expect(script.calls).toHaveLength(1);
    expect(demo.suggestions.inFlight()).toBe(1);
    script.calls[0]?.open([{ text: 'Only once?' }]);
    await vi.runAllTimersAsync();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.suggestions).toEqual([{ text: 'Only once?', target: 'a', up: 0 }]);
    expect(script.calls).toHaveLength(1);
    expect(demo.suggestions.inFlight()).toBe(0);
  });

  it('a failure answers 502, leaves the node missing, and the next POST retries', async () => {
    const { demo, script, read } = setup({}, [{ delayMs: 50, picks: 'fail' }]);
    const before = read('t/a/node.md');
    const failed = apiError(demo.api.generateSuggestions('t', 'a'));
    await vi.runAllTimersAsync();
    expect(await failed).toMatchObject({
      status: 502,
      code: 'suggestions_failed',
      message: SUGGESTIONS_FAILED_MESSAGE,
    });
    expect(SUGGESTIONS_FAILED_MESSAGE).toBe(
      'Could not generate suggestions. They will be retried the next time the node is opened.',
    );
    expect(read('t/a/node.md')).toBe(before);
    expect(demo.suggestions.inFlight()).toBe(0);
    const retry = demo.api.generateSuggestions('t', 'a');
    await vi.runAllTimersAsync();
    expect(await retry).toMatchObject({ state: 'ready' });
    expect(script.calls).toHaveLength(2);
  });

  describe('takes no lock: structural edits succeed while generating', () => {
    it('moved: 404 node_not_found, nothing written anywhere', async () => {
      const { demo, script, read } = setup({}, [{ picks: 'gate' }]);
      const post = apiError(demo.api.generateSuggestions('t', 'a/b'));
      await expect(demo.api.moveNodes('t', ['a/b'], 'c')).resolves.toMatchObject({
        moved: { 'a/b': 'c/b' },
      });
      script.calls[0]?.open([{ text: 'Lost?' }]);
      await vi.runAllTimersAsync();
      expect(await post).toMatchObject({ status: 404, code: 'node_not_found' });
      expect(read('t/c/b/node.md')).not.toContain('suggestions:');
      expect(demo.vfs.exists('t/a/b')).toBe(false);
    });

    it('renamed: 404 node_not_found', async () => {
      const { demo, script, read } = setup({}, [{ picks: 'gate' }]);
      const post = apiError(demo.api.generateSuggestions('t', 'a/b'));
      await expect(demo.api.renameNode('t', 'a/b', 'bee')).resolves.toMatchObject({ id: 'a/bee' });
      script.calls[0]?.open([{ text: 'Lost?' }]);
      await vi.runAllTimersAsync();
      expect(await post).toMatchObject({ status: 404, code: 'node_not_found' });
      expect(read('t/a/bee/node.md')).not.toContain('suggestions:');
      expect(demo.vfs.exists('t/a/b')).toBe(false);
    });

    it('deleted: 404, the trash is untouched and no folder is recreated', async () => {
      const { demo, script, read } = setup({}, [{ picks: 'gate' }]);
      const post = apiError(demo.api.generateSuggestions('t', 'a/b'));
      const { deleted } = await demo.api.deleteNodes('t', ['a/b']);
      const trash = `t/${deleted['a/b']}/node.md`;
      const before = read(trash);
      script.calls[0]?.open([{ text: 'Lost?' }]);
      await vi.runAllTimersAsync();
      expect(await post).toMatchObject({ status: 404, code: 'node_not_found' });
      expect(read(trash)).toBe(before);
      expect(demo.vfs.exists('t/a/b')).toBe(false);
    });

    it('restore succeeds and the generation is still written', async () => {
      const { demo, script, stored } = setup({}, [{ picks: 'gate' }]);
      const { deleted } = await demo.api.deleteNodes('t', ['a/b']);
      const post = demo.api.generateSuggestions('t', 'c');
      await expect(demo.api.restoreNodes('t', [deleted['a/b'] as string])).resolves.toMatchObject({
        restored: { [deleted['a/b'] as string]: 'a/b' },
      });
      script.calls[0]?.open([{ text: 'Kept?' }]);
      await vi.runAllTimersAsync();
      expect(await post).toMatchObject({ state: 'ready' });
      expect(stored('t/c/node.md')).toEqual(own('Kept?'));
    });

    it('tree renamed: 404 tree_not_found, nothing written under either id', async () => {
      const { demo, script, read } = setup({}, [{ picks: 'gate' }]);
      const post = apiError(demo.api.generateSuggestions('t', 'a/b'));
      await expect(demo.api.updateTree('t', { title: 'Renamed' })).resolves.toMatchObject({
        id: 'renamed',
      });
      script.calls[0]?.open([{ text: 'Lost?' }]);
      await vi.runAllTimersAsync();
      expect(await post).toMatchObject({ status: 404, code: 'tree_not_found' });
      expect(read('renamed/a/b/node.md')).not.toContain('suggestions:');
      expect(demo.vfs.exists('t')).toBe(false);
    });

    it('moved away and back before the result: written', async () => {
      const { demo, script, stored } = setup({}, [{ picks: 'gate' }]);
      const post = demo.api.generateSuggestions('t', 'a/b');
      await demo.api.moveNodes('t', ['a/b'], 'c');
      await demo.api.moveNodes('t', ['c/b'], 'a');
      script.calls[0]?.open([{ text: 'Back?' }]);
      await vi.runAllTimersAsync();
      expect(await post).toMatchObject({ state: 'ready' });
      expect(stored('t/a/b/node.md')).toEqual(own('Back?'));
    });
  });

  it('discards the result when node.md changed meanwhile (502)', async () => {
    const { demo, script, read } = setup({}, [{ picks: 'gate' }]);
    const post = apiError(demo.api.generateSuggestions('t', 'a'));
    const changed = NODE('A?', '2026-01-01T00:01:00.000Z').replace('Answer to A?', 'Changed');
    demo.vfs.transaction(() => demo.vfs.writeText('t/a/node.md', changed));
    script.calls[0]?.open([{ text: 'Stale?' }]);
    await vi.runAllTimersAsync();
    expect(await post).toMatchObject({ status: 502, code: 'suggestions_failed' });
    expect(read('t/a/node.md')).toBe(changed);
  });

  it('keeps a list another writer stored meanwhile (200 with theirs)', async () => {
    const { demo, script, stored } = setup({}, [{ picks: 'gate' }]);
    const post = demo.api.generateSuggestions('t', 'a');
    const theirs = NODE('A?', '2026-01-01T00:01:00.000Z', own('Theirs?'));
    demo.vfs.transaction(() => demo.vfs.writeText('t/a/node.md', theirs));
    script.calls[0]?.open([{ text: 'Ours?' }]);
    await vi.runAllTimersAsync();
    expect((await post).suggestions).toEqual([{ text: 'Theirs?', target: 'a', up: 0 }]);
    expect(stored('t/a/node.md')).toEqual(own('Theirs?'));
  });

  it('a full storage answers 502, rolls back, and the next POST succeeds', async () => {
    const { demo, script, storage, read } = setup({}, [{ picks: 'gate' }]);
    const before = read('t/a/node.md');
    const post = apiError(demo.api.generateSuggestions('t', 'a'));
    storage.failNextSave();
    script.calls[0]?.open([{ text: 'Too big?' }]);
    await vi.runAllTimersAsync();
    expect(await post).toMatchObject({ status: 502, code: 'suggestions_failed' });
    expect(read('t/a/node.md')).toBe(before);
    const retry = demo.api.generateSuggestions('t', 'a');
    await vi.runAllTimersAsync();
    expect(await retry).toMatchObject({ state: 'ready' });
  });

  it('offers the nearest stored ancestor list as candidates, minus asked questions', async () => {
    const { demo, script, stored } = setup(
      {
        't/plan/node.md': NODE('Plan?', at(10), own('A', 'B', 'C')),
        't/plan/a/node.md': NODE('A', at(11)),
      },
      [{ picks: [{ keep: 0 }, { keep: 1 }] }],
    );
    const post = demo.api.generateSuggestions('t', 'plan/a');
    await vi.runAllTimersAsync();
    expect(script.calls[0]?.input.candidates).toEqual<SuggestionCandidate[]>([
      { text: 'B', source: 'plan', origin: 0 },
      { text: 'C', source: 'plan', origin: 0 },
    ]);
    expect(stored('t/plan/a/node.md')).toEqual([
      { text: 'B', up: 1 },
      { text: 'C', up: 1 },
    ]);
    expect((await post).suggestions).toEqual([
      { text: 'B', target: 'plan', up: 1 },
      { text: 'C', target: 'plan', up: 1 },
    ]);
  });

  it('skips missing ancestors when looking for candidates', async () => {
    const { demo, script, stored } = setup(
      {
        't/g/node.md': NODE('G?', at(10), own('X', 'Y')),
        't/g/p/node.md': NODE('P?', at(11)),
        't/g/p/v/node.md': NODE('V?', at(12)),
      },
      [{ picks: [{ keep: 0 }] }],
    );
    const post = demo.api.generateSuggestions('t', 'g/p/v');
    await vi.runAllTimersAsync();
    expect(script.calls[0]?.input.candidates).toEqual([
      { text: 'X', source: 'g', origin: 0 },
      { text: 'Y', source: 'g', origin: 0 },
    ]);
    expect(stored('t/g/p/v/node.md')).toEqual([{ text: 'X', up: 2 }]);
    expect(stored('t/g/p/node.md')).toBeUndefined();
    expect((await post).suggestions).toEqual([{ text: 'X', target: 'g', up: 2 }]);
  });
});

describe('default simulator', () => {
  const signal = new AbortController().signal;
  const candidates: SuggestionCandidate[] = [
    { text: 'B', source: 'p', origin: 0 },
    { text: 'C', source: 'p', origin: 0 },
  ];
  const input = (user: string, nodeId?: string) => ({
    treeId: 't',
    ...(nodeId !== undefined && { nodeId }),
    ancestors: [],
    current: { user, assistant: 'Lorem ipsum.' },
    candidates,
    signal,
  });
  /** Small LCG: deterministic sequences for the determinism check. */
  const seeded = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  it('plan-like questions get three steps and keep every candidate', () => {
    const result = simulateSuggestions(() => 0.5)(input('Make a plan for ownership'));
    expect(result.picks).toEqual([
      { text: "Let's start with step 1 of ownership" },
      { text: "Let's go to step 2 of ownership" },
      { text: "Let's go to step 3 of ownership" },
      { keep: 0 },
      { keep: 1 },
    ]);
    expect(result.delayMs).toBe(625);
  });

  it('asking a step continues the plan instead of starting a new one', () => {
    const result = simulateSuggestions(() => 0.5)(input("Let's start with step 1 of ownership"));
    expect(result.picks).toEqual([
      { text: 'Give me a short exercise on step 1 of ownership' },
      { text: 'How does step 1 of ownership work under the hood?' },
      { keep: 0 },
      { keep: 1 },
    ]);
  });

  it('sometimes returns nothing; fails only at save', () => {
    expect(simulateSuggestions(() => 0.05)(input('Why?')).picks).toEqual([]);
    expect(simulateSuggestions(() => 0.05)(input('Why?', 'n')).picks).toEqual([]);
    expect(simulateSuggestions(() => 0.15)(input('Why?')).picks).toBe('fail');
    const lazy = simulateSuggestions(() => 0.15)(input('Why?', 'n'));
    expect(Array.isArray(lazy.picks) && lazy.picks.length).toBeGreaterThan(0);
    expect(lazy.delayMs).toBe(600 + Math.floor(0.15 * 900));
  });

  it('is deterministic for a given random sequence and topic-cuts the question', () => {
    const question = 'How exactly do lifetimes and borrowing interact in loops?\nMore text';
    expect(simulateSuggestions(seeded(7))(input(question))).toEqual(
      simulateSuggestions(seeded(7))(input(question)),
    );
    const result = simulateSuggestions(() => 0.5)(input(question));
    expect(result.picks).toEqual([
      { text: 'Give me a short exercise on How exactly do lifetimes and borrowing' },
      { text: 'How does How exactly do lifetimes and borrowing work under the hood?' },
      { keep: 0 },
      { keep: 1 },
    ]);
    const files = simulateSuggestions(() => 0.5)(input('Attached files: a.png'));
    expect(files.picks).toContainEqual({ text: 'Give me a short exercise on these files' });
  });
});
