import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseBlockItem,
  splitSuggestionBlock,
  wholeItem,
} from '../../../server/src/storage/suggestion-block';
import type { StoredSuggestion } from '../../../server/src/storage/suggestions';
import { ApiError } from '../../../web/src/api/client';
import { parseNodeFile } from './format';
import {
  mapAnswer,
  type SimulatedBlockInput,
  simulateSuggestionBlock,
  splitParts,
  suggestionTopic,
  wholeText,
} from './suggestions';
import { type BlockStep, makeDemo, NODE, SMALL_SEED, scriptedBlocks, WHOLE } from './test-helpers';

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

  it("a map's whole item targets its parent, is last, never inherited and hides once used", async () => {
    const { demo } = setup({
      't/m/node.md': NODE('M?', at(10), [...own('P1', 'P2'), WHOLE('W')]),
      't/m/p/node.md': NODE('P1', at(11)),
      't/a/n/node.md': NODE('N?', at(12), [...own('Q1', 'Q2'), WHOLE('W2')]),
    });
    const view = async (id: string) => (await demo.api.getSuggestions('t', id)).suggestions;
    expect(await view('m')).toEqual([
      { text: 'P2', target: 'm', up: 0 },
      { text: 'W', target: '', up: 1, kind: 'whole' },
    ]);
    expect(await view('m/p')).toEqual([{ text: 'P2', target: 'm', up: 1 }]);
    expect(await view('a/n')).toEqual([
      { text: 'Q1', target: 'a/n', up: 0 },
      { text: 'Q2', target: 'a/n', up: 0 },
      { text: 'W2', target: 'a', up: 1, kind: 'whole' },
    ]);
    demo.vfs.transaction(() => demo.vfs.writeText('t/w/node.md', NODE('W', at(13))));
    expect(await view('m')).toEqual([{ text: 'P2', target: 'm', up: 0 }]);
    await demo.api.deleteNodes('t', ['w']);
    expect((await view('m')).at(-1)).toEqual({ text: 'W', target: '', up: 1, kind: 'whole' });
  });

  it('the whole item follows a move', async () => {
    const { demo } = setup({
      't/a/n/node.md': NODE('N?', at(12), [...own('Q1', 'Q2'), WHOLE('W2')]),
    });
    const whole = async (id: string) =>
      (await demo.api.getSuggestions('t', id)).suggestions.find((item) => item.kind);
    await demo.api.moveNodes('t', ['a/n'], 'c');
    expect(await whole('c/n')).toEqual({ text: 'W2', target: 'c', up: 1, kind: 'whole' });
    await demo.api.moveNodes('t', ['c/n'], '');
    expect(await whole('n')).toEqual({ text: 'W2', target: '', up: 1, kind: 'whole' });
  });

  it('an unknown kind is never shown', async () => {
    const raw = NODE('U?', at(10)).replace(
      'model: claude-opus-5-5\n',
      'model: claude-opus-5-5\nsuggestions: [{"text":"X","up":0,"kind":"future"},{"text":"Y","up":0}]\n',
    );
    const { demo } = setup({ 't/u/node.md': raw });
    expect((await demo.api.getSuggestions('t', 'u')).suggestions).toEqual([
      { text: 'Y', target: 'u', up: 0 },
    ]);
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

  it('never offers the whole item', async () => {
    const { demo, script } = setup({
      't/m/node.md': NODE('M?', at(10), [...own('P1', 'P2'), WHOLE('W')]),
    });
    await ask(demo, 'm', 'Other?');
    expect(script.calls[0]?.openSuggestions).toEqual(['P1', 'P2']);
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

  it('big-topic questions get every part, then the open suggestions, then one whole item', () => {
    const expected = [
      'Explain part 1 of ownership',
      'Explain part 2 of ownership',
      'Explain part 3 of ownership',
      'B',
      'C',
      wholeItem('Explain all of ownership in one answer, without splitting it'),
    ];
    for (const r of [0, 0.1, 0.45, 0.5, 0.99]) {
      expect(simulateSuggestionBlock(() => r)(input('Make a plan for ownership'))).toEqual(
        expected,
      );
    }
  });

  it('a part question keeps exactly the open suggestions; none → no block', () => {
    const part = 'Explain part 1 of ownership';
    expect(simulateSuggestionBlock(() => 0.5)(input(part))).toEqual(['B', 'C']);
    expect(simulateSuggestionBlock(() => 0.5)(input(part, []))).toBeUndefined();
    // A part whose topic names a chapter is not split again.
    expect(simulateSuggestionBlock(() => 0.5)(input('Explain part 2 of chapter 4'))).toEqual([
      'B',
      'C',
    ]);
  });

  it('a request for everything in one answer is never split', () => {
    const simulate = simulateSuggestionBlock(() => 0.5);
    const whole = simulate(input(wholeText('chapter 4')));
    expect(whole).toEqual([
      'Give me a short exercise on chapter 4',
      'How does chapter 4 work under the hood?',
      'B',
      'C',
    ]);
    const atOnce = simulate(input('Make a plan for ownership, all at once')) ?? [];
    expect(atOnce.slice(-2)).toEqual(['B', 'C']);
    for (const item of [...(whole ?? []), ...atOnce]) {
      expect(parseBlockItem(item).kind).toBeUndefined();
    }
  });

  it('splitParts: the own regular items of a list with a whole item', () => {
    const list: StoredSuggestion[] = [...own('P1', 'P2'), { text: 'K', up: 1 }, WHOLE('W')];
    expect(splitParts(list)).toEqual(['P1', 'P2']);
    expect(splitParts(own('P1', 'P2'))).toBeUndefined();
    expect(splitParts([])).toBeUndefined();
  });

  it('mapAnswer: the "too big" sentence and the numbered parts, nothing else', () => {
    const answer = mapAnswer(['Explain part 1 of x', 'Explain part 2 of x']);
    expect(answer.startsWith('This topic is too big for one answer')).toBe(true);
    const first = answer.indexOf('1. Part 1 of x');
    expect(first).toBeGreaterThan(0);
    expect(answer.indexOf('2. Part 2 of x')).toBeGreaterThan(first);
    expect(answer).not.toContain('<!--');
    expect(answer).not.toContain('```');
    expect(splitSuggestionBlock(answer).items).toBeUndefined();
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
    expect(suggestionTopic('Explain part 1 of ownership')).toBe('part 1 of ownership');
    expect(suggestionTopic(wholeText('ownership'))).toBe('ownership');
    expect(simulateSuggestionBlock(() => 0.5)(input('', []))).toContain(
      'Give me a short exercise on these files',
    );
  });
});
