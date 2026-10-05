import { describe, expect, it } from 'vitest';
import type { DoneQuestion, QuestionContext, QuestionInfo, RunningQuestion } from '../api/types';
import {
  acceptedFocus,
  askAsideTarget,
  focusedIn,
  openPendingTarget,
  reconcileFocus,
} from './question-focus';
import { initialQuestionsState, type OutboxEntry, type QuestionsState } from './questions';
import { mergeUrlState, type UrlState } from './url-state';

const side = (anchor: string): QuestionContext => ({ kind: 'side', anchor });

const running = (id: string, overrides: Partial<RunningQuestion> = {}): RunningQuestion => ({
  id,
  tree: 't',
  parentId: 'основы',
  context: { kind: 'main' },
  text: 'q',
  title: 'q',
  files: [],
  model: 'm',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: 'c',
  updatedAt: 'u',
  ...overrides,
});

const done = (id: string, overrides: Partial<DoneQuestion> = {}): DoneQuestion => ({
  ...running(id),
  status: 'done',
  nodeId: 'основы/новый',
  attachments: [],
  ...overrides,
});

function state(questions: QuestionInfo[], extra: Partial<QuestionsState> = {}): QuestionsState {
  return {
    ...initialQuestionsState,
    hydrated: true,
    questions: Object.fromEntries(questions.map((question) => [question.id, question])),
    ...extra,
  };
}

const url = (partial: Partial<UrlState> = {}): UrlState => ({
  tree: 't',
  node: 'основы',
  question: null,
  side: null,
  ...partial,
});

/** Applying a patch makes the function return null. */
function expectIdempotent(current: UrlState, store: QuestionsState) {
  const patch = reconcileFocus(current, store);
  expect(patch).not.toBeNull();
  expect(reconcileFocus(mergeUrlState(current, patch ?? {}), store)).toBeNull();
}

describe('reconcileFocus: main', () => {
  it('drops an unknown focus only after hydration', () => {
    const current = url({ question: 'x' });
    expect(reconcileFocus(current, { ...state([]), hydrated: false })).toBeNull();
    expect(reconcileFocus(current, state([]))).toEqual({ question: null });
  });

  it('drops a focus of another tree', () => {
    expect(reconcileFocus(url({ question: 'a' }), state([running('a', { tree: 'u' })]))).toEqual({
      question: null,
    });
  });

  it('keeps a done question until it is acked, then follows it to its node', () => {
    const current = url({ question: 'a' });
    expect(reconcileFocus(current, state([done('a')]))).toBeNull();
    const acked = state([done('a')], { acked: { a: true } });
    expect(reconcileFocus(current, acked)).toEqual({ node: 'основы/новый', question: null });
    expectIdempotent(current, acked);
  });

  it('follows a remapped parent', () => {
    const current = url({ question: 'a' });
    const store = state([running('a', { parentId: 'x/основы' })]);
    expect(reconcileFocus(current, store)).toEqual({ node: 'x/основы', question: 'a' });
    expectIdempotent(current, store);
  });

  it('reconciles a known id before hydration', () => {
    const store = { ...state([running('a', { parentId: 'x' })]), hydrated: false };
    expect(reconcileFocus(url({ question: 'a' }), store)).toEqual({ node: 'x', question: 'a' });
  });

  it('returns null when everything matches', () => {
    expect(reconcileFocus(url({ question: 'a' }), state([running('a')]))).toBeNull();
    expect(reconcileFocus(url(), state([]))).toBeNull();
  });
});

describe('reconcileFocus: side', () => {
  const aside = (anchor: string, head: string | null, question: string | null) => ({
    anchor,
    head,
    question,
  });

  it('drops an unknown, foreign or non-side question', () => {
    expect(reconcileFocus(url({ side: aside('a', null, 'x') }), state([]))).toEqual({
      side: aside('a', null, null),
    });
    expect(
      reconcileFocus(url({ side: aside('a', null, 'q') }), state([running('q', { tree: 'u' })])),
    ).toEqual({ side: aside('a', null, null) });
    expect(reconcileFocus(url({ side: aside('a', null, 'q') }), state([running('q')]))).toEqual({
      side: aside('a', null, null),
    });
  });

  it('follows a saved and acked side answer to its node as the new head', () => {
    const current = url({ side: aside('a', null, 'q') });
    const store = state([done('q', { parentId: 'a', context: side('a'), nodeId: 'a/b' })], {
      acked: { q: true },
    });
    expect(reconcileFocus(current, store)).toEqual({ side: aside('a', 'a/b', null) });
    expectIdempotent(current, store);
  });

  it('keeps the head when the created node is no valid head (stale completion)', () => {
    // The aside was re-anchored meanwhile: the node lies outside its branch.
    const store = state([done('q', { parentId: 'z', context: side('z'), nodeId: 'z/b' })], {
      acked: { q: true },
    });
    expect(reconcileFocus(url({ side: aside('a', 'a/c', 'q') }), store)).toEqual({
      side: aside('a', 'a/c', null),
    });
  });

  it('aligns anchor and head with the question', () => {
    const current = url({ side: aside('a', null, 'q') });
    const store = state([running('q', { parentId: 'x/a/b', context: side('x/a') })]);
    expect(reconcileFocus(current, store)).toEqual({ side: aside('x/a', 'x/a/b', 'q') });
    expectIdempotent(current, store);
    const onAnchor = state([running('q', { parentId: 'x/a', context: side('x/a') })]);
    expect(reconcileFocus(current, onAnchor)).toEqual({ side: aside('x/a', null, 'q') });
  });

  it('merges main and side patches', () => {
    const store = state([
      running('m', { parentId: 'b' }),
      running('s', { parentId: 'a', context: side('a') }),
    ]);
    expect(
      reconcileFocus(url({ node: 'a', question: 'm', side: aside('', null, 's') }), store),
    ).toEqual({ node: 'b', question: 'm', side: aside('a', null, 's') });
  });

  it('ignores a closed aside (stale completion)', () => {
    const store = state([done('q', { context: side('a') })], { acked: { q: true } });
    expect(reconcileFocus(url(), store)).toBeNull();
  });
});

describe('acceptedFocus', () => {
  it('focuses a main question while the URL still targets its parent', () => {
    expect(acceptedFocus(url(), running('a'))).toEqual({ question: 'a' });
    expect(acceptedFocus(url({ node: 'x' }), running('a'))).toBeNull();
    expect(acceptedFocus(url({ question: 'other' }), running('a'))).toBeNull();
    expect(acceptedFocus(url({ tree: 'u' }), running('a'))).toBeNull();
  });

  it('focuses a side question in the same aside only', () => {
    const question = running('s', { parentId: 'a/b', context: side('a') });
    const open = { anchor: 'a', head: 'a/b', question: null };
    expect(acceptedFocus(url({ side: open }), question)).toEqual({
      side: { ...open, question: 's' },
    });
    expect(acceptedFocus(url({ side: { ...open, head: null } }), question)).toBeNull();
    expect(acceptedFocus(url({ side: { ...open, anchor: 'z' } }), question)).toBeNull();
    expect(acceptedFocus(url({ side: { ...open, question: 'x' } }), question)).toBeNull();
    expect(acceptedFocus(url(), question)).toBeNull();
  });
});

describe('openPendingTarget', () => {
  const outbox: OutboxEntry = {
    id: 'out-1',
    tree: 't',
    parentId: 'a',
    context: side('a'),
    stashKey: 't:side:a',
    text: 'q',
    files: [],
    phase: 'sending',
    error: null,
    createdAt: 'c',
  };

  it('opens main questions at their parent', () => {
    expect(openPendingTarget('m', state([running('m', { parentId: 'b' })]))).toEqual({
      tree: 't',
      node: 'b',
      question: 'm',
    });
  });

  it('opens side questions in the aside (no head on the anchor)', () => {
    const store = state([
      running('s', { parentId: 'a', context: side('a') }),
      running('r', { parentId: 'a/b', context: side('a') }),
    ]);
    expect(openPendingTarget('s', store)).toEqual({
      tree: 't',
      side: { anchor: 'a', head: null, question: 's' },
    });
    expect(openPendingTarget('r', store)).toEqual({
      tree: 't',
      side: { anchor: 'a', head: 'a/b', question: 'r' },
    });
  });

  it('finds questions by their local box key and opens sends without a question', () => {
    const store = state([running('q', { parentId: 'b' })], {
      localKeys: { q: 'out-9' },
      outbox: { 'out-1': outbox },
    });
    expect(openPendingTarget('out-9', store)).toEqual({ tree: 't', node: 'b', question: 'q' });
    expect(openPendingTarget('out-1', store)).toEqual({
      tree: 't',
      side: { anchor: 'a', head: null, question: null },
    });
    expect(openPendingTarget('nothing', store)).toBeNull();
  });
});

describe('askAsideTarget and focusedIn', () => {
  it('is disabled while the main chat shows a question', () => {
    expect(askAsideTarget(url({ question: 'q' }))).toBe('disabled');
  });

  it('reuses an idle aside on the same anchor, otherwise opens a new one', () => {
    const idle = { anchor: 'основы', head: null, question: null };
    expect(askAsideTarget(url({ side: idle }))).toBeNull();
    expect(askAsideTarget(url({ side: { ...idle, question: 's' } }))).toEqual({
      side: { anchor: 'основы', head: null, question: null },
    });
    expect(askAsideTarget(url())).toEqual({
      side: { anchor: 'основы', head: null, question: null },
    });
  });

  it('tells which panel shows a question', () => {
    const current = url({ question: 'm', side: { anchor: '', head: null, question: 's' } });
    expect(focusedIn(current, 'm')).toBe('main');
    expect(focusedIn(current, 's')).toBe('side');
    expect(focusedIn(current, 'x')).toBeNull();
  });
});
