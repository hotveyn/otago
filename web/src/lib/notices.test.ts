import { describe, expect, it, vi } from 'vitest';
import {
  addNotice,
  dismissNotice,
  getNotices,
  NOTICE_CAP,
  type Notice,
  pushNotice,
  removeNotice,
  subscribeNotices,
} from './notices';

const notice = (id: number, key?: string): Notice => ({
  id,
  kind: 'info',
  message: `n${id}`,
  ...(key ? { key } : {}),
});

describe('notice list', () => {
  it('appends newest last and caps the list', () => {
    let list: Notice[] = [];
    for (let id = 1; id <= NOTICE_CAP + 2; id += 1) list = addNotice(list, notice(id));
    expect(list.map((item) => item.id)).toEqual([3, 4, 5]);
  });

  it('replaces a notice with the same key', () => {
    const list = addNotice([notice(1, 'a'), notice(2)], notice(3, 'a'));
    expect(list.map((item) => item.id)).toEqual([2, 3]);
  });

  it('removes by id', () => {
    expect(removeNotice([notice(1), notice(2)], 1)).toEqual([notice(2)]);
  });
});

describe('notice store', () => {
  it('pushes, notifies and dismisses', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotices(listener);
    const id = pushNotice({ kind: 'error', message: 'boom', key: 'k' });
    expect(getNotices().at(-1)).toEqual({ id, kind: 'error', message: 'boom', key: 'k' });
    dismissNotice(id);
    expect(getNotices().some((item) => item.id === id)).toBe(false);
    dismissNotice(id);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
