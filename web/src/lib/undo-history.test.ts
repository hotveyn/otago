import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { KeyValueStore } from './storage';
import {
  classifyUndoError,
  completeStep,
  type DeleteHistoryEntry,
  HISTORY_CAP,
  type HistoryEntry,
  historyKey,
  loadHistory,
  type MoveHistoryEntry,
  nextStep,
  recordDelete,
  recordMove,
  remapHistory,
  remapId,
  renameHistoryKey,
  restoredAsMoves,
  runUndo,
  saveHistory,
  type UndoApi,
} from './undo-history';

const NOW = '2026-09-27T00:00:00.000Z';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      if (value === null) data.delete(key);
      else data.set(key, value);
    },
  };
}

const moveEntry = (items: MoveHistoryEntry['items'], id = 'm'): MoveHistoryEntry => ({
  type: 'move',
  id,
  at: NOW,
  items,
});

const deleteEntry = (items: DeleteHistoryEntry['items'], id = 'd'): DeleteHistoryEntry => ({
  type: 'delete',
  id,
  at: NOW,
  items,
});

function fakeApi(overrides: Partial<UndoApi> = {}) {
  return {
    move: vi.fn<UndoApi['move']>(async (ids, target, names) => ({
      moved: Object.fromEntries(
        ids.map((id) => [id, (target ? `${target}/` : '') + (names[id] ?? id)]),
      ),
      nodes: [],
    })),
    restore: vi.fn<UndoApi['restore']>(async (trashIds) => ({
      restored: Object.fromEntries(trashIds.map((id) => [id, id.replace(/\.deleted-\d+$/, '')])),
      nodes: [],
    })),
    ...overrides,
  };
}

describe('remapId', () => {
  it('rewrites an exact match and descendants', () => {
    expect(remapId('a', { a: 'x/a' })).toBe('x/a');
    expect(remapId('a/b/c', { a: 'x/a' })).toBe('x/a/b/c');
  });

  it('does not touch ids that only share a string prefix', () => {
    expect(remapId('ab', { a: 'x/a' })).toBe('ab');
    expect(remapId('ab/c', { a: 'x/a' })).toBe('ab/c');
  });

  it('ignores identity pairs and the root key', () => {
    expect(remapId('a/b', { a: 'a' })).toBe('a/b');
    expect(remapId('a', { '': 'x' })).toBe('a');
  });

  it('rewrites a TrashId whose parent moved', () => {
    expect(remapId('p/c.deleted-1', { p: 'q/p' })).toBe('q/p/c.deleted-1');
    expect(remapId('p.deleted-2/c', { 'p.deleted-2': 'p' })).toBe('p/c');
  });

  it('applies only the first matching pair (no chaining)', () => {
    expect(remapId('a', { a: 'b', b: 'c' })).toBe('b');
  });
});

describe('recordMove', () => {
  it('derives old parent and name and omits identity pairs', () => {
    const entries = recordMove([], { 'a/b': 'x/b', c: 'x/c-2', 'x/d': 'x/d' }, NOW, 'id1');
    expect(entries).toEqual([
      moveEntry(
        [
          { currentId: 'x/b', oldParentId: 'a', oldName: 'b' },
          { currentId: 'x/c-2', oldParentId: '', oldName: 'c' },
        ],
        'id1',
      ),
    ]);
  });

  it('records nothing when every pair is identity', () => {
    const before: HistoryEntry[] = [];
    expect(recordMove(before, { a: 'a' }, NOW, 'id')).toBe(before);
  });

  it('remaps older entries but not the new one', () => {
    const older: HistoryEntry[] = [
      moveEntry([{ currentId: 'a/k', oldParentId: 'a/j', oldName: 'k' }], 'm0'),
      deleteEntry([{ trashId: 'a/t.deleted-1', originalId: 'a/t' }], 'd0'),
    ];
    const entries = recordMove(older, { a: 'x/a' }, NOW, 'm1');
    expect(entries[0]).toEqual(
      moveEntry([{ currentId: 'x/a/k', oldParentId: 'x/a/j', oldName: 'k' }], 'm0'),
    );
    expect(entries[1]).toEqual(
      deleteEntry([{ trashId: 'x/a/t.deleted-1', originalId: 'x/a/t' }], 'd0'),
    );
    expect(entries[2]).toEqual(
      moveEntry([{ currentId: 'x/a', oldParentId: '', oldName: 'a' }], 'm1'),
    );
  });
});

describe('recordDelete', () => {
  it('records trash ids', () => {
    expect(recordDelete([], { 'a/b': 'a/b.deleted-1' }, NOW, 'd1')).toEqual([
      deleteEntry([{ trashId: 'a/b.deleted-1', originalId: 'a/b' }], 'd1'),
    ]);
  });

  it('rewrites older ids inside the deleted subtree into the trash path', () => {
    const older = [moveEntry([{ currentId: 'p/a', oldParentId: '', oldName: 'a' }])];
    const entries = recordDelete(older, { p: 'p.deleted-1' }, NOW, 'd1');
    expect(entries[0]).toEqual(
      moveEntry([{ currentId: 'p.deleted-1/a', oldParentId: '', oldName: 'a' }]),
    );
  });

  it('records nothing for an older server without `deleted`', () => {
    const before: HistoryEntry[] = [];
    expect(recordDelete(before, {}, NOW, 'd')).toBe(before);
  });
});

describe('cap', () => {
  it('drops the oldest entry past the cap and keeps order', () => {
    let entries: HistoryEntry[] = [];
    for (let i = 0; i <= HISTORY_CAP; i++)
      entries = recordDelete(entries, { [`n${i}`]: `n${i}.deleted-1` }, NOW, `e${i}`);
    expect(entries).toHaveLength(HISTORY_CAP);
    expect(entries[0]?.id).toBe('e1');
    expect(entries.at(-1)?.id).toBe(`e${HISTORY_CAP}`);
  });
});

describe('load / save', () => {
  const sample: HistoryEntry[] = [
    moveEntry([{ currentId: 'x/a', oldParentId: '', oldName: 'a' }]),
    deleteEntry([{ trashId: 'b.deleted-1', originalId: 'b' }]),
  ];

  it('round-trips per tree', () => {
    const store = memoryStore();
    saveHistory(store, 't1', sample);
    expect(loadHistory(store, 't1')).toEqual(sample);
    expect(loadHistory(store, 't2')).toEqual([]);
  });

  it('removes the key for an empty stack', () => {
    const store = memoryStore();
    saveHistory(store, 't', sample);
    saveHistory(store, 't', []);
    expect(store.data.has(historyKey('t'))).toBe(false);
  });

  it('drops invalid JSON and a wrong version', () => {
    const store = memoryStore();
    store.set(historyKey('t'), '{nope');
    expect(loadHistory(store, 't')).toEqual([]);
    store.set(historyKey('t'), JSON.stringify({ v: 2, entries: sample }));
    expect(loadHistory(store, 't')).toEqual([]);
  });

  it('drops unknown types and malformed entries, keeping the rest', () => {
    const store = memoryStore();
    store.set(
      historyKey('t'),
      JSON.stringify({
        v: 1,
        entries: [
          sample[0],
          { type: 'rename-node', id: 'r', at: NOW, currentId: 'a', oldName: 'b' },
          { type: 'move', id: 'x', at: NOW, items: [{ currentId: 'a' }] },
          { type: 'delete', id: 'y', at: NOW, items: [] },
          { type: 'toString', id: 'z', at: NOW, items: [] },
          'junk',
          sample[1],
        ],
      }),
    );
    expect(loadHistory(store, 't')).toEqual(sample);
  });

  it('moves a stack to a renamed tree', () => {
    const store = memoryStore();
    saveHistory(store, 'old', sample);
    renameHistoryKey(store, 'old', 'new');
    expect(loadHistory(store, 'new')).toEqual(sample);
    expect(store.data.has(historyKey('old'))).toBe(false);
  });
});

describe('nextStep / completeStep', () => {
  it('groups a move by old parent with the original names', () => {
    const entry = moveEntry([
      { currentId: 'x/a', oldParentId: 'p', oldName: 'a' },
      { currentId: 'x/b-2', oldParentId: 'q', oldName: 'b' },
      { currentId: 'x/c', oldParentId: 'p', oldName: 'c' },
    ]);
    const first = nextStep(entry);
    expect(first).toEqual({
      kind: 'move',
      items: [0, 2],
      ids: ['x/a', 'x/c'],
      targetParentId: 'p',
      names: { 'x/a': 'a', 'x/c': 'c' },
    });
    const rest = first && completeStep(entry, first);
    expect(rest).toEqual(moveEntry([{ currentId: 'x/b-2', oldParentId: 'q', oldName: 'b' }]));
    const second = rest && nextStep(rest);
    expect(second).toMatchObject({ targetParentId: 'q', names: { 'x/b-2': 'b' } });
    expect(rest && second && completeStep(rest, second)).toBeNull();
  });

  it('restores all trash ids of a delete in one step', () => {
    const entry = deleteEntry([
      { trashId: 'a.deleted-1', originalId: 'a' },
      { trashId: 'p/b.deleted-1', originalId: 'p/b' },
    ]);
    const step = nextStep(entry);
    expect(step).toEqual({
      kind: 'restore',
      items: [0, 1],
      trashIds: ['a.deleted-1', 'p/b.deleted-1'],
    });
    expect(step && completeStep(entry, step)).toBeNull();
  });
});

describe('restoredAsMoves', () => {
  it('lists only nodes that came back under another id', () => {
    const entry = deleteEntry([
      { trashId: 'a.deleted-1', originalId: 'a' },
      { trashId: 'b.deleted-1', originalId: 'b' },
    ]);
    expect(restoredAsMoves(entry, { 'a.deleted-1': 'a', 'b.deleted-1': 'b-2' })).toEqual({
      b: 'b-2',
    });
  });
});

describe('classifyUndoError', () => {
  it.each([
    [
      new ApiError(404, 'x', 'parent_not_found'),
      true,
      "Can't undo: the original parent no longer exists.",
    ],
    [
      new ApiError(404, 'x', 'trash_not_found'),
      true,
      "Can't undo: the deleted node is gone from the trash.",
    ],
    [new ApiError(404, 'x', 'node_not_found'), true, "Can't undo: the node no longer exists."],
    [new ApiError(404, 'x', 'tree_not_found'), true, "Can't undo: the tree no longer exists."],
    [new ApiError(404, 'x'), true, "Can't undo: the tree changed since then."],
    [new ApiError(400, 'bad'), true, "Can't undo this change."],
    [
      new ApiError(409, 'busy', 'tree_busy_streaming'),
      false,
      'An answer is still streaming. Try again when it finishes.',
    ],
    [
      new ApiError(409, 'busy', 'tree_busy_structural'),
      false,
      'Nodes are being moved, renamed or deleted. Try again in a moment.',
    ],
    [new ApiError(500, 'boom'), false, 'Undo failed: boom'],
    [new TypeError('Failed to fetch'), false, 'Undo failed: Failed to fetch'],
  ])('%s', (error, drop, message) => {
    expect(classifyUndoError(error)).toEqual({ drop, message });
  });
});

describe('runUndo', () => {
  it('does nothing on an empty stack', async () => {
    const api = fakeApi();
    expect(await runUndo([], api)).toEqual({ entries: [] });
    expect(api.move).not.toHaveBeenCalled();
    expect(api.restore).not.toHaveBeenCalled();
  });

  it('moves nodes back under their old parent with the old name', async () => {
    const api = fakeApi();
    const onStep = vi.fn();
    const entries = recordMove([], { 'p/a': 'x/a-2' }, NOW, 'm');
    const outcome = await runUndo(entries, api, onStep);
    expect(api.move).toHaveBeenCalledWith(['x/a-2'], 'p', { 'x/a-2': 'a' });
    expect(outcome).toEqual({ entries: [] });
    expect(onStep).toHaveBeenCalledWith({
      nodes: [],
      fixups: { 'x/a-2': 'p/a' },
      kind: 'move',
      entries: [],
    });
  });

  it('remaps older entries when the move back gets a -2 name', async () => {
    let entries = recordMove([], { 'p/a/k': 'p/a/j/k' }, NOW, 'm0');
    entries = recordMove(entries, { 'p/a': 'x/a' }, NOW, 'm1');
    const api = fakeApi({
      move: vi.fn(async () => ({ moved: { 'x/a': 'p/a-2' }, nodes: [] })),
    });
    const outcome = await runUndo(entries, api);
    expect(outcome.entries).toEqual([
      moveEntry([{ currentId: 'p/a-2/j/k', oldParentId: 'p/a-2', oldName: 'k' }], 'm0'),
    ]);
  });

  it('restores a delete and reports renamed nodes as fixups', async () => {
    const entries = recordDelete([], { a: 'a.deleted-1', b: 'b.deleted-1' }, NOW, 'd');
    const api = fakeApi({
      restore: vi.fn(async () => ({
        restored: { 'a.deleted-1': 'a', 'b.deleted-1': 'b-2' },
        nodes: [],
      })),
    });
    const onStep = vi.fn();
    const outcome = await runUndo(entries, api, onStep);
    expect(api.restore).toHaveBeenCalledWith(['a.deleted-1', 'b.deleted-1']);
    expect(outcome).toEqual({ entries: [] });
    expect(onStep).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'restore', fixups: { b: 'b-2' } }),
    );
  });

  it('undoes move-then-delete-parent in LIFO order', async () => {
    let entries = recordMove([], { a: 'p/a' }, NOW, 'm');
    entries = recordDelete(entries, { p: 'p.deleted-1' }, NOW, 'd');
    const api = fakeApi();
    let outcome = await runUndo(entries, api);
    expect(api.restore).toHaveBeenCalledWith(['p.deleted-1']);
    expect(outcome.entries).toEqual([
      moveEntry([{ currentId: 'p/a', oldParentId: '', oldName: 'a' }], 'm'),
    ]);
    outcome = await runUndo(outcome.entries, api);
    expect(api.move).toHaveBeenCalledWith(['p/a'], '', { 'p/a': 'a' });
    expect(outcome.entries).toEqual([]);
  });

  it('undoes child-then-parent deletes through rewritten trash ids', async () => {
    let entries = recordDelete([], { 'p/c': 'p/c.deleted-1' }, NOW, 'd0');
    entries = recordDelete(entries, { p: 'p.deleted-2' }, NOW, 'd1');
    expect(entries[0]).toEqual(
      deleteEntry([{ trashId: 'p.deleted-2/c.deleted-1', originalId: 'p.deleted-2/c' }], 'd0'),
    );
    const api = fakeApi();
    let outcome = await runUndo(entries, api);
    expect(api.restore).toHaveBeenLastCalledWith(['p.deleted-2']);
    outcome = await runUndo(outcome.entries, api);
    expect(api.restore).toHaveBeenLastCalledWith(['p/c.deleted-1']);
    expect(outcome.entries).toEqual([]);
  });

  it('keeps the unfinished part of a move when a later group hits a 409', async () => {
    const older = deleteEntry([{ trashId: 'z.deleted-1', originalId: 'z' }], 'd');
    const entries = recordMove([older], { 'p/a': 'x/a', 'q/b': 'x/b' }, NOW, 'm');
    const move = vi
      .fn<UndoApi['move']>()
      .mockResolvedValueOnce({ moved: { 'x/a': 'p/a' }, nodes: [] })
      .mockRejectedValueOnce(new ApiError(409, 'busy', 'tree_busy_structural'));
    const onStep = vi.fn();
    const outcome = await runUndo(entries, fakeApi({ move }), onStep);
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(outcome.entries).toEqual([
      older,
      moveEntry([{ currentId: 'x/b', oldParentId: 'q', oldName: 'b' }], 'm'),
    ]);
    expect(outcome.error).toEqual({
      message: 'Nodes are being moved, renamed or deleted. Try again in a moment.',
      dropped: false,
    });
  });

  it.each([
    ['parent_not_found', "Can't undo: the original parent no longer exists."],
    ['trash_not_found', "Can't undo: the deleted node is gone from the trash."],
    ['node_not_found', "Can't undo: the node no longer exists."],
  ] as const)('drops a stale entry on 404 %s and keeps the rest', async (code, message) => {
    const older = moveEntry([{ currentId: 'x/a', oldParentId: '', oldName: 'a' }], 'm');
    const entries = [older, deleteEntry([{ trashId: 'b.deleted-1', originalId: 'b' }])];
    const restore = vi.fn(async () => {
      throw new ApiError(404, 'gone', code);
    });
    const outcome = await runUndo(entries, fakeApi({ restore }));
    expect(outcome).toEqual({ entries: [older], error: { message, dropped: true } });
  });

  it('drops the entry on 400', async () => {
    const entries = [deleteEntry([{ trashId: 'b.deleted-1', originalId: 'b' }])];
    const restore = vi.fn(async () => {
      throw new ApiError(400, 'bad');
    });
    const outcome = await runUndo(entries, fakeApi({ restore }));
    expect(outcome.entries).toEqual([]);
    expect(outcome.error?.dropped).toBe(true);
  });

  it.each([
    new ApiError(409, 'busy', 'tree_busy_streaming'),
    new ApiError(409, 'busy', 'tree_busy_structural'),
    new ApiError(500, 'boom'),
    new TypeError('Failed to fetch'),
  ])('keeps the entry on %s', async (error) => {
    const entries = [deleteEntry([{ trashId: 'b.deleted-1', originalId: 'b' }])];
    const restore = vi.fn(async () => {
      throw error;
    });
    const outcome = await runUndo(entries, fakeApi({ restore }));
    expect(outcome.entries).toBe(entries);
    expect(outcome.error?.dropped).toBe(false);
  });
});

describe('remapHistory', () => {
  it('rewrites move and delete entries with a full rename map', () => {
    const renamed = { a: 'b', 'a/x': 'b/x' };
    const entries: HistoryEntry[] = [
      moveEntry([{ currentId: 'a/x/m', oldParentId: 'a', oldName: 'm' }]),
      deleteEntry([{ trashId: 'a/z.deleted-1', originalId: 'a/z' }]),
    ];
    expect(remapHistory(entries, renamed)).toEqual([
      moveEntry([{ currentId: 'b/x/m', oldParentId: 'b', oldName: 'm' }]),
      deleteEntry([{ trashId: 'b/z.deleted-1', originalId: 'b/z' }]),
    ]);
  });

  it('returns the same array for an identity rename map', () => {
    const entries = [deleteEntry([{ trashId: 'a/z.deleted-1', originalId: 'a/z' }])];
    expect(remapHistory(entries, { a: 'a', 'a/x': 'a/x' })).toBe(entries);
  });

  it('returns the same array when nothing changes', () => {
    const entries = [moveEntry([{ currentId: 'x/a', oldParentId: '', oldName: 'a' }])];
    expect(remapHistory(entries, { q: 'r' })).toBe(entries);
  });
});
