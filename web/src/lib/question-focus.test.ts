import { describe, expect, it } from 'vitest';
import type { DoneQuestion, QuestionContext, QuestionInfo, RunningQuestion } from '../api/types';
import {
  acceptedFocus,
  askAsideTarget,
  focusedIn,
  openPendingTarget,
  reconcileFocus,
  sendFocusTarget,
} from './question-focus';
import { initialQuestionsState, type OutboxEntry, type QuestionsState } from './questions';
import { isValidHead, mergeUrlState, type UrlState } from './url-state';

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

  it('anchors on the node the text was selected in, not the main focus', () => {
    expect(askAsideTarget(url({ node: 'основы/глубже' }), 'основы')).toEqual({
      side: { anchor: 'основы', head: null, question: null },
    });
    const idle = { anchor: 'основы', head: null, question: null };
    expect(askAsideTarget(url({ node: 'основы/глубже', side: idle }), 'основы')).toBeNull();
    expect(askAsideTarget(url({ node: 'основы/глубже', side: idle }), '')).toEqual({
      side: { anchor: '', head: null, question: null },
    });
  });

  it('tells which panel shows a question', () => {
    const current = url({ question: 'm', side: { anchor: '', head: null, question: 's' } });
    expect(focusedIn(current, 'm')).toBe('main');
    expect(focusedIn(current, 's')).toBe('side');
    expect(focusedIn(current, 'x')).toBeNull();
  });
});

describe('sendFocusTarget', () => {
  const MAIN: QuestionContext = { kind: 'main' };

  /** Applying the patch makes the function return null. */
  function applied(current: UrlState, context: QuestionContext, parentId: string): UrlState {
    const patch = sendFocusTarget(current, context, parentId);
    expect(patch).not.toBeNull();
    const next = mergeUrlState(current, patch ?? {});
    expect(sendFocusTarget(next, context, parentId)).toBeNull();
    return next;
  }

  describe('main', () => {
    it('moves the main panel to the parent with no question', () => {
      const current = url({ node: 'основы/карта' });
      expect(sendFocusTarget(current, MAIN, 'основы')).toEqual({ node: 'основы', question: null });
      expect(sendFocusTarget(current, MAIN, '')).toEqual({ node: '', question: null });
    });

    it('is null when the panel already targets the parent with no question', () => {
      expect(sendFocusTarget(url({ node: 'основы' }), MAIN, 'основы')).toBeNull();
    });

    it('drops a focused question at the same node', () => {
      expect(sendFocusTarget(url({ question: 'x' }), MAIN, 'основы')).toEqual({
        node: 'основы',
        question: null,
      });
    });

    it('is idempotent', () => {
      applied(url({ node: 'основы/карта' }), MAIN, 'основы');
      applied(url({ node: 'карта' }), MAIN, '');
    });
  });

  describe('side', () => {
    const SIDE = side('а');
    const current = url({
      node: 'х',
      question: 'm',
      side: { anchor: 'а', head: 'а/б/карта', question: null },
    });

    it('moves the head to the parent, or to null at the anchor', () => {
      expect(sendFocusTarget(current, SIDE, 'а/б')).toEqual({
        side: { anchor: 'а', head: 'а/б', question: null },
      });
      expect(sendFocusTarget(current, SIDE, 'а')).toEqual({
        side: { anchor: 'а', head: null, question: null },
      });
    });

    it('is null for a parent above the anchor, another aside or no aside', () => {
      expect(sendFocusTarget(current, SIDE, '')).toBeNull();
      expect(sendFocusTarget(current, side('б'), 'б')).toBeNull();
      expect(sendFocusTarget(url(), SIDE, 'а')).toBeNull();
    });

    it('leaves the main panel untouched and is idempotent', () => {
      const next = applied(current, SIDE, 'а/б');
      expect(next.node).toBe('х');
      expect(next.question).toBe('m');
      applied(current, SIDE, 'а');
    });
  });

  describe('composition with acceptedFocus and reconcileFocus', () => {
    it('main: move, focus on the 202, follow to the saved node', () => {
      const url0 = url({ node: 'основы/карта' });
      const url1 = mergeUrlState(url0, sendFocusTarget(url0, MAIN, 'основы') ?? {});
      const focus = acceptedFocus(url1, running('a', { parentId: 'основы' }));
      expect(focus).toEqual({ question: 'a' });
      const url2 = mergeUrlState(url1, focus ?? {});
      expect(reconcileFocus(url2, state([done('a')], { acked: { a: true } }))).toEqual({
        node: 'основы/новый',
        question: null,
      });
    });

    it('main, root: the same for a top-level map', () => {
      const url0 = url({ node: 'карта' });
      const url1 = mergeUrlState(url0, sendFocusTarget(url0, MAIN, '') ?? {});
      const focus = acceptedFocus(url1, running('a', { parentId: '' }));
      expect(focus).toEqual({ question: 'a' });
      const url2 = mergeUrlState(url1, focus ?? {});
      const saved = state([done('a', { parentId: '', nodeId: 'новый' })], { acked: { a: true } });
      expect(reconcileFocus(url2, saved)).toEqual({ node: 'новый', question: null });
    });

    it('side: move, focus on the 202, follow to the saved node as the head', () => {
      const context = side('а');
      const url0 = url({ side: { anchor: 'а', head: 'а/б/карта', question: null } });
      const url1 = mergeUrlState(url0, sendFocusTarget(url0, context, 'а/б') ?? {});
      const focus = acceptedFocus(url1, running('a', { parentId: 'а/б', context }));
      expect(focus).toEqual({ side: { anchor: 'а', head: 'а/б', question: 'a' } });
      const url2 = mergeUrlState(url1, focus ?? {});
      const saved = state([done('a', { parentId: 'а/б', context, nodeId: 'а/б/новый' })], {
        acked: { a: true },
      });
      expect(isValidHead('а/б/новый', 'а')).toBe(true);
      expect(reconcileFocus(url2, saved)).toEqual({
        side: { anchor: 'а', head: 'а/б/новый', question: null },
      });
    });

    it('side: a parent equal to the anchor (head null) still gets the 202 focus', () => {
      const context = side('а');
      const url0 = url({ side: { anchor: 'а', head: 'а/карта', question: null } });
      const url1 = mergeUrlState(url0, sendFocusTarget(url0, context, 'а') ?? {});
      expect(url1.side).toEqual({ anchor: 'а', head: null, question: null });
      expect(acceptedFocus(url1, running('a', { parentId: 'а', context }))).toEqual({
        side: { anchor: 'а', head: null, question: 'a' },
      });
    });

    it('without the move the 202 does not focus (regression guard)', () => {
      const url0 = url({ node: 'основы/карта' });
      expect(acceptedFocus(url0, running('a', { parentId: 'основы' }))).toBeNull();
    });
  });
});
