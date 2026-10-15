import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSuggestion } from '../../../server/src/storage/suggestions';
import { ApiError } from '../../../web/src/api/client';
import { parseNodeFile } from './format';
import { type SimulatedBlockInput, simulateSuggestionBlock, suggestionTopic } from './suggestions';
import { type BlockStep, makeDemo, NODE, SMALL_SEED, scriptedBlocks } from './test-helpers';

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
const main = { kind: 'main' } as const;

function setup(extra: Record<string, string> = {}, steps: BlockStep[] = []) {
  const script = scriptedBlocks(steps);
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
  it('reports stored empty lists; a node without a list inherits', async () => {
    const { demo } = setup({
      't/e/node.md': NODE('E?', at(10), []),
      't/p/node.md': NODE('P?', at(11), own('N1')),
      't/p/q/node.md': NODE('Q?', at(12)),
      't/g/node.md': NODE('G?', at(13), own('X')),
      't/g/s/node.md': NODE('S?', at(14), []),
      't/g/s/u/node.md': NODE('U?', at(15)),
    });
    expect(await demo.api.getSuggestions('t', 'e')).toEqual({
      node: 'e',
      state: 'ready',
      suggestions: [],
    });
    // No list and no stored ancestor.
    expect(await demo.api.getSuggestions('t', 'a')).toEqual({
      node: 'a',
      state: 'ready',
      suggestions: [],
    });
    expect(await demo.api.getSuggestions('t', 'p/q')).toEqual({
      node: 'p/q',
      state: 'ready',
      suggestions: [{ text: 'N1', target: 'p', up: 1 }],
    });
    // A stored empty list stops the fallback.
    expect((await demo.api.getSuggestions('t', 'g/s/u')).suggestions).toEqual([]);
  });

  it('the fallback drops an item asked between the list and the node', async () => {
    const { demo } = setup({
      't/g/node.md': NODE('G?', at(10), own('X', 'Y')),
      't/g/p/node.md': NODE('X', at(11)),
      't/g/p/v/node.md': NODE('V?', at(12)),
    });
    expect((await demo.api.getSuggestions('t', 'g/p/v')).suggestions).toEqual([
      { text: 'Y', target: 'g', up: 2 },
    ]);
    // `X` is also used under `g`.
    expect((await demo.api.getSuggestions('t', 'g')).suggestions).toEqual([
      { text: 'Y', target: 'g', up: 0 },
    ]);
  });

  it('is not capped', async () => {
    const texts = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
    const { demo } = setup({ 't/n/node.md': NODE('N?', at(10), own(...texts)) });
    const { suggestions } = await demo.api.getSuggestions('t', 'n');
    expect(suggestions.map((item) => item.text)).toEqual(texts);
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

  it('validates like the server; there is no POST', async () => {
    const { demo, script } = setup();
    const get = demo.api.getSuggestions;
    const root = await apiError(get('t', ''));
    expect(root).toMatchObject({ status: 400, message: 'The tree root has no suggestions' });
    expect(await apiError(get('t', 'A B'))).toMatchObject({ status: 400 });
    expect(await apiError(get('t', 'a/files'))).toMatchObject({ status: 400 });
    expect(await apiError(get('t', 'a'.repeat(1001)))).toMatchObject({
      status: 400,
      message: 'Invalid input',
    });
    expect(await apiError(get('nope', 'a'))).toMatchObject({ status: 404, code: 'tree_not_found' });
    expect(await apiError(get('t', 'zz'))).toMatchObject({ status: 404, code: 'node_not_found' });
    expect('generateSuggestions' in demo.api).toBe(false);
    expect(script.calls).toHaveLength(0);
  });

  it('normalizes the node id to NFC', async () => {
    const { demo } = setup({ 't/ёж/node.md': NODE('Ёж?', at(10), own('Next?')) });
    const response = await demo.api.getSuggestions('t', 'ёж'.normalize('NFD'));
    expect(response).toMatchObject({ node: 'ёж', state: 'ready' });
  });

  it('never conflicts: reads while a question of the tree streams', async () => {
    const { demo } = setup({ 't/n/node.md': NODE('N?', at(10), own('Next?')) });
    await demo.api.startQuestion('t', { parentId: 'c', text: 'Busy?', context: main });
    expect((await apiError(demo.api.moveNodes('t', ['a'], 'c'))).status).toBe(409);
    expect((await demo.api.getSuggestions('t', 'n')).suggestions).toEqual([
      { text: 'Next?', target: 'n', up: 0 },
    ]);
  });
});

describe('suggestions: candidates offered to the answering agent', () => {
  const ask = async (demo: ReturnType<typeof setup>['demo'], parentId: string, text: string) => {
    await demo.api.startQuestion('t', { parentId, text, context: main });
    await vi.runAllTimersAsync();
  };

  it("offers the parent's open items, minus the ones a live child asks", async () => {
    const { demo, script } = setup({
      't/plan/node.md': NODE('Plan?', at(10), own('A', 'B', 'C')),
      't/plan/a/node.md': NODE('A', at(11)),
    });
    await ask(demo, 'plan', 'Other?');
    expect(script.calls[0]).toEqual<SimulatedBlockInput>({
      treeId: 't',
      parentId: 'plan',
      question: 'Other?',
      openSuggestions: ['B', 'C'],
      attempt: 1,
    });
  });

  it('a parent without a list offers its nearest stored ancestor list (fallback)', async () => {
    const { demo, script, stored } = setup(
      {
        't/g/node.md': NODE('G?', at(10), own('X', 'Y')),
        't/g/p/node.md': NODE('P?', at(11)),
      },
      [['X']],
    );
    await ask(demo, 'g/p', 'Deeper?');
    expect(script.calls[0]?.openSuggestions).toEqual(['X', 'Y']);
    expect(stored('t/g/p/deeper/node.md')).toEqual([{ text: 'X', up: 2 }]);
    expect((await demo.api.getSuggestions('t', 'g/p/deeper')).suggestions).toEqual([
      { text: 'X', target: 'g', up: 2 },
    ]);
  });

  it("does not offer the question's own text", async () => {
    const { demo, script } = setup({
      't/plan/node.md': NODE('Plan?', at(10), own('A', 'B', 'C')),
      't/plan/a/node.md': NODE('A', at(11)),
    });
    await ask(demo, 'plan', ' B ');
    expect(script.calls[0]?.openSuggestions).toEqual(['C']);
  });

  it('a top-level question gets no open suggestions', async () => {
    const { demo, script } = setup({ 't/n/node.md': NODE('N?', at(10), own('Next?')) });
    await ask(demo, '', 'Top?');
    expect(script.calls[0]?.openSuggestions).toEqual([]);
  });
});

describe('default block simulator', () => {
  const input = (question: string, openSuggestions: string[] = ['B', 'C']) => ({
    treeId: 't',
    parentId: 'p',
    question,
    openSuggestions,
    attempt: 1,
  });
  /** Small LCG: deterministic sequences for the determinism check. */
  const seeded = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  it('plan-like questions get three steps, then every open suggestion', () => {
    expect(simulateSuggestionBlock(() => 0.5)(input('Make a plan for ownership'))).toEqual([
      "Let's start with step 1 of ownership",
      "Let's go to step 2 of ownership",
      "Let's go to step 3 of ownership",
      'B',
      'C',
    ]);
  });

  it('a step question keeps exactly the open suggestions; none → no block', () => {
    const step = "Let's start with step 1 of ownership";
    expect(simulateSuggestionBlock(() => 0.5)(input(step))).toEqual(['B', 'C']);
    expect(simulateSuggestionBlock(() => 0.5)(input(step, []))).toBeUndefined();
  });

  it('often no block, sometimes the marker alone, else templates plus open suggestions', () => {
    expect(simulateSuggestionBlock(() => 0.1)(input('Why?'))).toBeUndefined();
    expect(simulateSuggestionBlock(() => 0.45)(input('Why?'))).toEqual([]);
    expect(simulateSuggestionBlock(() => 0.45)(input('Why?', []))).toBeUndefined();
    expect(simulateSuggestionBlock(() => 0.5)(input('Why?'))).toEqual([
      'Give me a short exercise on Why',
      'How does Why work under the hood?',
      'B',
      'C',
    ]);
  });

  it('is deterministic for a given random sequence and topic-cuts the question', () => {
    const question = 'How exactly do lifetimes and borrowing interact in loops?\nMore text';
    expect(simulateSuggestionBlock(seeded(7))(input(question))).toEqual(
      simulateSuggestionBlock(seeded(7))(input(question)),
    );
    expect(simulateSuggestionBlock(() => 0.5)(input(question, []))).toEqual([
      'Give me a short exercise on How exactly do lifetimes and borrowing',
      'How does How exactly do lifetimes and borrowing work under the hood?',
    ]);
    expect(suggestionTopic(question)).toBe('How exactly do lifetimes and borrowing');
    expect(suggestionTopic('')).toBe('these files');
    expect(suggestionTopic('Attached files: a.png')).toBe('these files');
    expect(simulateSuggestionBlock(() => 0.5)(input('', []))).toContain(
      'Give me a short exercise on these files',
    );
  });
});
