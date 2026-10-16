import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type {
  DoneQuestion,
  FailedQuestion,
  QuestionInfo,
  RunningQuestion,
  Suggestion,
} from '../api/types';
import { draftStash } from './draft-stash';
import { createQuestionStore, type QuestionApi } from './question-store';
import {
  initialQuestionsState,
  type LifecycleEvent,
  type OutboxEntry,
  type QuestionsState,
  shallowArrayEqual,
} from './questions';
import {
  askSuggestion,
  hasInFlightSuggestion,
  inFlightSuggestionKeys,
  isKnownSuggestion,
  isWholeSuggestion,
  SUGGESTION_LABEL_GRAPHEMES,
  suggestionKey,
  suggestionLabel,
  suggestionMovesFocus,
  suggestionSource,
  visibleSuggestions,
} from './suggestions';

const running = (id: string, overrides: Partial<RunningQuestion> = {}): RunningQuestion => ({
  id,
  tree: 't',
  parentId: 'план',
  context: { kind: 'main' },
  text: 'Глава 2',
  title: 'Глава 2',
  files: [],
  model: 'm',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: '2026-10-04T10:00:00.000Z',
  updatedAt: '2026-10-04T10:00:00.000Z',
  ...overrides,
});

const done = (id: string, overrides: Partial<DoneQuestion> = {}): DoneQuestion => ({
  ...running(id),
  status: 'done',
  nodeId: 'план/глава-2',
  attachments: [],
  ...overrides,
});

const failed = (id: string, overrides: Partial<FailedQuestion> = {}): FailedQuestion => ({
  ...running(id),
  status: 'failed',
  error: { code: 'agent_error', message: 'x' },
  ...overrides,
});

const outbox = (id: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id,
  tree: 't',
  parentId: 'план',
  context: { kind: 'main' },
  stashKey: 't:main',
  text: 'Глава 2',
  files: [],
  phase: 'sending',
  error: null,
  createdAt: '2026-10-04T10:00:00.000Z',
  ...overrides,
});

function stateOf(
  questions: QuestionInfo[] = [],
  entries: OutboxEntry[] = [],
  acked: string[] = [],
): QuestionsState {
  return {
    ...initialQuestionsState,
    hydrated: true,
    questions: Object.fromEntries(questions.map((q) => [q.id, q])),
    outbox: Object.fromEntries(entries.map((e) => [e.id, e])),
    acked: Object.fromEntries(acked.map((id) => [id, true as const])),
  };
}

const key = (target: string, text: string) => `${target}\0${text}`;

const own = (text: string, target = 'план/глава-1'): Suggestion => ({ text, target, up: 0 });
const inherited = (text: string, target = 'план', up = 1): Suggestion => ({ text, target, up });
const whole = (text: string, target = 'план'): Suggestion => ({
  text,
  target,
  up: 1,
  kind: 'whole',
});
const unknownKind = (text: string, target = 'план/глава-1'): Suggestion =>
  ({ text, target, up: 0, kind: 'extra' }) as unknown as Suggestion;

describe('suggestionKey', () => {
  it('trims', () => {
    expect(suggestionKey('  Глава 2\n')).toBe('Глава 2');
  });

  it('treats NFD and NFC as equal', () => {
    expect(suggestionKey('й'.normalize('NFD'))).toBe(suggestionKey('й'.normalize('NFC')));
    expect(suggestionKey('café'.normalize('NFD'))).toBe(suggestionKey('café'.normalize('NFC')));
  });

  it('is case-sensitive', () => {
    expect(suggestionKey('Глава 2')).not.toBe(suggestionKey('глава 2'));
  });

  it('keeps inner whitespace', () => {
    expect(suggestionKey('a  b')).toBe('a  b');
  });
});

describe('inFlightSuggestionKeys', () => {
  it('includes live sends in both phases', () => {
    const state = stateOf(
      [],
      [outbox('out-1'), outbox('out-2', { phase: 'uploading', text: 'Другое' })],
    );
    expect(inFlightSuggestionKeys(state, 't', ['план'])).toEqual(
      [key('план', 'Глава 2'), key('план', 'Другое')].sort(),
    );
  });

  it('excludes a "Not sent" entry', () => {
    const state = stateOf([], [outbox('out-1', { error: new Error('x') })]);
    expect(inFlightSuggestionKeys(state, 't', ['план'])).toEqual([]);
  });

  it('includes streaming, naming, failed and done-but-not-acked questions', () => {
    for (const question of [
      running('a'),
      running('b', { status: 'naming' }),
      failed('c'),
      done('d'),
    ]) {
      expect(inFlightSuggestionKeys(stateOf([question]), 't', ['план'])).toEqual([
        key('план', 'Глава 2'),
      ]);
    }
  });

  it('excludes done and acked questions', () => {
    expect(inFlightSuggestionKeys(stateOf([done('d')], [], ['d']), 't', ['план'])).toEqual([]);
  });

  it('excludes other trees and parents not in targets', () => {
    const state = stateOf(
      [running('a', { tree: 'other' }), running('b', { parentId: 'план/глава-1' })],
      [outbox('out-1', { tree: 'other' }), outbox('out-2', { parentId: 'другое' })],
    );
    expect(inFlightSuggestionKeys(state, 't', ['план'])).toEqual([]);
    expect(inFlightSuggestionKeys(state, 't', [])).toEqual([]);
  });

  it('normalizes the entry text', () => {
    const state = stateOf([running('a', { text: '  Глава 2\n' })]);
    expect(inFlightSuggestionKeys(state, 't', ['план'])).toEqual([key('план', 'Глава 2')]);
  });

  it('returns sorted unique keys that compare equal across calls', () => {
    const state = stateOf(
      [running('a', { text: 'б' }), running('b', { text: 'а' }), failed('c', { text: 'б' })],
      [outbox('out-1', { text: 'а' })],
    );
    const first = inFlightSuggestionKeys(state, 't', ['план']);
    expect(first).toEqual([key('план', 'а'), key('план', 'б')]);
    expect(shallowArrayEqual(first, inFlightSuggestionKeys(state, 't', ['план']))).toBe(true);
  });
});

describe('inFlightSuggestionKeys with the root target', () => {
  it('finds an outbox entry and a running question with parentId ""', () => {
    const state = stateOf(
      [running('a', { parentId: '', text: 'Целиком' })],
      [outbox('out-1', { parentId: '', text: 'Другое' })],
    );
    expect(inFlightSuggestionKeys(state, 't', [''])).toEqual([
      key('', 'Другое'),
      key('', 'Целиком'),
    ]);
  });
});

describe('visibleSuggestions', () => {
  const main = { anchor: null };

  describe('kinds', () => {
    it('drops an unknown kind and keeps the regular items around it in order', () => {
      const list = [own('a'), unknownKind('b'), own('c')];
      expect(visibleSuggestions(list, [], main)).toEqual([own('a'), own('c')]);
    });

    it('keeps a whole item whose text equals an own item, and the own item too', () => {
      const list = [own('Вопрос'), whole('Вопрос')];
      expect(visibleSuggestions(list, [], main)).toEqual(list);
    });

    it('is not removed by a preceding inherited duplicate and hides nothing', () => {
      const list = [inherited('Вопрос', 'план', 1), whole('Вопрос')];
      expect(visibleSuggestions(list, [], main)).toEqual(list);
      const reversed = [whole('Вопрос'), inherited('Вопрос', 'план', 1)];
      expect(visibleSuggestions(reversed, [], main)).toEqual([reversed[1], reversed[0]]);
    });

    it('places a whole item last and keeps the regular order', () => {
      const list = [whole('W'), own('a'), inherited('b'), own('c')];
      expect(visibleSuggestions(list, [], main)).toEqual([
        own('a'),
        inherited('b'),
        own('c'),
        whole('W'),
      ]);
    });

    it('keeps only the first of two whole items, placed last', () => {
      const list = [whole('W1'), own('a'), whole('W2', '')];
      expect(visibleSuggestions(list, [], main)).toEqual([own('a'), whole('W1')]);
    });

    it('hides a whole item with an in-flight entry under its own target only', () => {
      expect(visibleSuggestions([whole('W', '')], [key('', 'W')], main)).toEqual([]);
      expect(visibleSuggestions([whole('W')], [key('план', 'W')], main)).toEqual([]);
      expect(visibleSuggestions([whole('W')], [key('', 'W')], main)).toEqual([whole('W')]);
    });

    it('applies the side anchor rule to whole items', () => {
      const anchor = { anchor: 'а/б' };
      expect(visibleSuggestions([whole('W', 'а/б')], [], anchor)).toEqual([whole('W', 'а/б')]);
      expect(visibleSuggestions([whole('W', 'а/б/в')], [], anchor)).toEqual([whole('W', 'а/б/в')]);
      expect(visibleSuggestions([whole('W', 'а')], [], anchor)).toEqual([]);
      expect(visibleSuggestions([whole('W', '')], [], { anchor: '' })).toEqual([whole('W', '')]);
    });
  });

  it('hides an item with an in-flight entry under its target only', () => {
    const list = [own('Глава 2', 'план'), inherited('Глава 2', 'корень')];
    expect(visibleSuggestions(list, [key('план', 'Глава 2')], main)).toEqual([
      inherited('Глава 2', 'корень'),
    ]);
  });

  describe('side anchor', () => {
    const list = [
      own('Свой', 'а/б/в'),
      inherited('Якорь', 'а/б'),
      inherited('Выше', 'а', 2),
      inherited('Сосед', 'аб', 1),
    ];

    it('keeps everything for the root anchor', () => {
      expect(visibleSuggestions(list, [], { anchor: '' })).toEqual(list);
    });

    it('keeps the anchor and its descendants, drops targets above it', () => {
      expect(visibleSuggestions(list, [], { anchor: 'а/б' })).toEqual([list[0], list[1]]);
    });

    it('drops a sibling-prefix target', () => {
      const prefix = [inherited('Сосед', 'а', 1), own('Свой', 'аб/в')];
      expect(visibleSuggestions(prefix, [], { anchor: 'аб' })).toEqual([prefix[1]]);
    });
  });

  it('lets an own item win over a duplicate inherited one that comes first', () => {
    const list = [inherited(' Вопрос'), own('Вопрос')];
    expect(visibleSuggestions(list, [], main)).toEqual([own('Вопрос')]);
  });

  it('keeps the first of two inherited items with the same key', () => {
    const list = [inherited('Вопрос', 'план', 1), inherited('Вопрос'.normalize('NFD'), 'к', 2)];
    expect(visibleSuggestions(list, [], main)).toEqual([list[0]]);
  });

  it('shows every item in order (no cap)', () => {
    const list = Array.from({ length: 12 }, (_, i) => own(`q${i}`));
    expect(visibleSuggestions(list, [], main)).toEqual(list);
  });

  it('passes an inherited-only list (ancestor fallback) through the same rules', () => {
    const list = [
      inherited('Глава 4', 'план/глава-3', 1),
      inherited('Глава 5', 'план/глава-3', 1),
      inherited('Обзор', 'план', 2),
    ];
    expect(visibleSuggestions(list, [], main)).toEqual(list);
    expect(visibleSuggestions(list, [], { anchor: 'план/глава-3' })).toEqual([list[0], list[1]]);
    expect(visibleSuggestions(list, [key('план/глава-3', 'Глава 4')], main)).toEqual([
      list[1],
      list[2],
    ]);
  });

  it('maps [] to []', () => {
    expect(visibleSuggestions([], [], main)).toEqual([]);
  });
});

describe('suggestionLabel', () => {
  const family = '👩‍👩‍👧';
  const devanagari = 'हि';

  it('keeps text that fits', () => {
    const text = 'я'.repeat(SUGGESTION_LABEL_GRAPHEMES);
    expect(suggestionLabel(text)).toBe(text);
  });

  it('cuts longer text with an ellipsis', () => {
    const text = 'я'.repeat(SUGGESTION_LABEL_GRAPHEMES + 1);
    expect(suggestionLabel(text)).toBe(`${'я'.repeat(SUGGESTION_LABEL_GRAPHEMES)}…`);
  });

  it('never splits a ZWJ sequence or a combining mark', () => {
    expect(suggestionLabel(family.repeat(SUGGESTION_LABEL_GRAPHEMES + 1))).toBe(
      `${family.repeat(SUGGESTION_LABEL_GRAPHEMES)}…`,
    );
    expect(suggestionLabel(devanagari.repeat(SUGGESTION_LABEL_GRAPHEMES + 3))).toBe(
      `${devanagari.repeat(SUGGESTION_LABEL_GRAPHEMES)}…`,
    );
  });
});

describe('suggestionSource', () => {
  it('is null for own items and the last id segment for inherited ones', () => {
    expect(suggestionSource(own('q'))).toBeNull();
    expect(suggestionSource(inherited('q', 'план/раздел', 2))).toBe('раздел');
  });
});

describe('suggestion kind predicates', () => {
  it('classifies regular, whole and unknown items', () => {
    expect([own('q'), whole('q'), unknownKind('q')].map(isKnownSuggestion)).toEqual([
      true,
      true,
      false,
    ]);
    expect([own('q'), whole('q'), unknownKind('q')].map(isWholeSuggestion)).toEqual([
      false,
      true,
      false,
    ]);
    expect([own('q'), whole('q'), unknownKind('q')].map(suggestionMovesFocus)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('gives a whole item no source tag, the root target included', () => {
    expect(suggestionSource(whole('q'))).toBeNull();
    expect(suggestionSource(whole('q', ''))).toBeNull();
  });
});

describe('hasInFlightSuggestion', () => {
  it('matches the target and the key', () => {
    const state = stateOf([running('a', { text: 'Глава 2 ' })]);
    expect(hasInFlightSuggestion(state, 't', own('Глава 2', 'план'))).toBe(true);
    expect(hasInFlightSuggestion(state, 't', own('Глава 2', 'другое'))).toBe(false);
    expect(hasInFlightSuggestion(state, 'u', own('Глава 2', 'план'))).toBe(false);
  });
});

describe('askSuggestion', () => {
  interface PendingStart {
    resolve: (question: QuestionInfo) => void;
    reject: (error: unknown) => void;
  }

  function setup(schedule: (run: () => void) => void = (run) => run()) {
    const starts: PendingStart[] = [];
    const api = {
      startQuestion: vi.fn<QuestionApi['startQuestion']>(
        (_tree, _input, signal) =>
          new Promise<QuestionInfo>((resolve, reject) => {
            starts.push({ resolve, reject });
            signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
      cancelQuestion: vi.fn<QuestionApi['cancelQuestion']>(async () => undefined),
      retryQuestion: vi.fn<QuestionApi['retryQuestion']>(async (id) => running(id)),
    };
    const store = createQuestionStore({ api, now: () => 1_000, schedule });
    const lifecycle: LifecycleEvent[] = [];
    store.onLifecycle((event) => lifecycle.push(event));
    return { api, store, starts, lifecycle };
  }

  const suggestion = inherited('Глава 2', 'план', 1);
  const input = {
    tree: 't',
    context: { kind: 'side', anchor: 'план' } as const,
    stashKey: 't:side:план',
    suggestion,
    model: 'claude-x',
    namingModel: null,
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('sends the text under the target with the panel context and no files', () => {
    const { api, store } = setup();
    expect(askSuggestion(store, input)).toMatch(/^out-/);
    expect(api.startQuestion).toHaveBeenCalledTimes(1);
    const [tree, body] = api.startQuestion.mock.calls[0] ?? [];
    expect(tree).toBe('t');
    expect(body).toEqual({
      parentId: 'план',
      text: 'Глава 2',
      model: 'claude-x',
      namingModel: undefined,
      context: { kind: 'side', anchor: 'план' },
      files: [],
    });
  });

  it('refuses a second click before and after the 202', async () => {
    const { api, store, starts } = setup();
    askSuggestion(store, input);
    expect(askSuggestion(store, input)).toBeNull();
    starts[0]?.resolve(running('q1', { context: input.context }));
    await tick();
    expect(store.getState().questions.q1?.status).toBe('streaming');
    expect(askSuggestion(store, input)).toBeNull();
    expect(api.startQuestion).toHaveBeenCalledTimes(1);
  });

  it('never restores the text when the send fails before the 202', async () => {
    const { store, starts, lifecycle } = setup();
    draftStash.set(input.stashKey, { text: 'черновик', files: [] });
    const id = askSuggestion(store, input) ?? '';
    starts[0]?.reject(new ApiError(409, 'busy', 'tree_busy_structural'));
    await tick();
    const ended = lifecycle.find((event) => event.type === 'outbox-ended');
    expect(ended).toMatchObject({ outcome: 'failed', restored: true, shown: false });
    expect(store.getState().outbox[id]).toBeUndefined();
    expect(draftStash.get(input.stashKey)).toEqual({ text: 'черновик', files: [] });
    // The button may be clicked again.
    expect(hasInFlightSuggestion(store.getState(), 't', suggestion)).toBe(false);
    draftStash.clear();
  });

  it('never restores the text on an abort', async () => {
    const { store, lifecycle } = setup();
    const id = askSuggestion(store, input) ?? '';
    store.abortOutbox(id);
    await tick();
    const ended = lifecycle.find((event) => event.type === 'outbox-ended');
    expect(ended).toMatchObject({ outcome: 'aborted', restored: true, shown: false });
    expect(store.getState().outbox[id]).toBeUndefined();
    expect(draftStash.get(input.stashKey)).toBeNull();
  });

  describe('whole items move focus', () => {
    const mainInput = {
      tree: 't',
      context: { kind: 'main' } as const,
      stashKey: 't:main',
      suggestion: whole('Целиком', ''),
      model: 'claude-x',
      namingModel: null,
    };

    it('sends to the root and moves after the outbox entry is published', () => {
      // Publishing is deferred, so only `flush` makes the entry visible to React.
      const { api, store } = setup(() => undefined);
      const seen: string[][] = [];
      const moveFocus = vi.fn((parentId: string) => {
        seen.push(Object.values(store.getSnapshot().outbox).map((entry) => entry.parentId));
        expect(parentId).toBe('');
      });
      const id = askSuggestion(store, { ...mainInput, moveFocus });
      expect(id).toMatch(/^out-/);
      expect(moveFocus).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([['']]);
      const [, body] = api.startQuestion.mock.calls[0] ?? [];
      expect(body).toMatchObject({ parentId: '', text: 'Целиком', files: [] });
    });

    it('moves a side panel to the target with the side context in the body', () => {
      const { api, store } = setup();
      const moveFocus = vi.fn();
      askSuggestion(store, { ...input, suggestion: whole('Целиком', 'план'), moveFocus });
      expect(moveFocus).toHaveBeenCalledExactlyOnceWith('план');
      const [, body] = api.startQuestion.mock.calls[0] ?? [];
      expect(body).toMatchObject({ parentId: 'план', context: { kind: 'side', anchor: 'план' } });
    });

    it('never moves for regular items', () => {
      const { store } = setup();
      const moveFocus = vi.fn();
      askSuggestion(store, { ...input, suggestion: own('Свой', 'план'), moveFocus });
      askSuggestion(store, { ...input, moveFocus });
      expect(moveFocus).not.toHaveBeenCalled();
    });

    it('does not move again on a refused second click', () => {
      const { api, store } = setup();
      const moveFocus = vi.fn();
      askSuggestion(store, { ...mainInput, moveFocus });
      expect(askSuggestion(store, { ...mainInput, moveFocus })).toBeNull();
      expect(moveFocus).toHaveBeenCalledTimes(1);
      expect(api.startQuestion).toHaveBeenCalledTimes(1);
    });

    it('sends normally without moveFocus', () => {
      const { api, store } = setup();
      expect(askSuggestion(store, mainInput)).toMatch(/^out-/);
      expect(api.startQuestion).toHaveBeenCalledTimes(1);
    });
  });
});
