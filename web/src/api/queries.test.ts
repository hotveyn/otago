import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { dropTreeCaches, keys, moveTreeCaches, seedDoneChain } from './queries';
import type { ChainNode, DoneQuestion, SourceInfo, TreeDetail, TreeMeta } from './types';

const meta = (id: string, title = id): TreeMeta => ({
  id,
  title,
  created: '2026-09-01T00:00:00.000Z',
  instructions: 'Be brief.',
});

const nodes = [{ id: 'a', name: 'a', created: '2026-09-01T00:00:01.000Z', children: [] }];
const sources: SourceInfo[] = [{ name: 'book.pdf', size: 3 }];

function seeded() {
  const client = new QueryClient();
  client.setQueryData<TreeDetail>(keys.tree('old'), { ...meta('old', 'Old'), nodes });
  client.setQueryData(keys.sources('old'), sources);
  client.setQueryData(keys.trees, [meta('first'), meta('old', 'Old'), meta('last')]);
  return client;
}

describe('moveTreeCaches', () => {
  it('seeds the new id with the old nodes and the new meta', () => {
    const client = seeded();
    const updated = { ...meta('new', 'New'), previous: { id: 'old', title: 'Old' } };
    moveTreeCaches(client, 'old', updated);
    expect(client.getQueryData(keys.tree('new'))).toEqual({ ...meta('new', 'New'), nodes });
    expect(client.getQueryData(keys.sources('new'))).toEqual(sources);
    expect(client.getQueryData(keys.trees)).toEqual([
      meta('first'),
      meta('new', 'New'),
      meta('last'),
    ]);
  });

  it('seeds nothing when the old entries are absent', () => {
    const client = new QueryClient();
    moveTreeCaches(client, 'old', meta('new'));
    expect(client.getQueryData(keys.tree('new'))).toBeUndefined();
    expect(client.getQueryData(keys.sources('new'))).toBeUndefined();
    expect(client.getQueryData(keys.trees)).toBeUndefined();
  });
});

describe('dropTreeCaches', () => {
  it('removes every cache of the old id and nothing else', () => {
    const client = seeded();
    moveTreeCaches(client, 'old', meta('new'));
    client.setQueryData(keys.chain('old', 'a'), []);
    client.setQueryData(keys.source('old', 'book.pdf'), 'text');
    client.setQueryData(keys.attachment('old', 'a', 'x.svg', 1), '<svg/>');
    client.setQueryData(keys.attachmentBlob('old', 'a', 'x.pdf', 1), 'blob');
    client.setQueryData(keys.chain('other', 'a'), []);
    client.setQueryData(keys.chain('new', 'a'), []);

    dropTreeCaches(client, 'old');

    const left = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(left.filter((key) => key[1] === 'old')).toEqual([]);
    expect(client.getQueryData(keys.tree('new'))).toBeDefined();
    expect(client.getQueryData(keys.sources('new'))).toEqual(sources);
    expect(client.getQueryData(keys.chain('new', 'a'))).toEqual([]);
    expect(client.getQueryData(keys.chain('other', 'a'))).toEqual([]);
    expect(client.getQueryData(keys.trees)).toBeDefined();
  });
});

describe('seedDoneChain', () => {
  const parent: ChainNode = {
    id: 'основы',
    name: 'основы',
    created: 'c',
    model: 'm',
    user: 'u',
    assistant: 'a',
    attachments: [],
    files: [],
  };
  const done: DoneQuestion = {
    id: 'q',
    tree: 't',
    parentId: 'основы',
    context: { kind: 'main' },
    text: 'Вопрос',
    title: 'Вопрос',
    files: [{ name: 'a.pdf', size: 1, contentType: 'application/pdf', kind: 'pdf' }],
    model: 'm2',
    namingModel: 'n',
    attempt: 1,
    status: 'done',
    nodeId: 'основы/ответ',
    attachments: [{ name: 'x.svg', size: 1, contentType: 'image/svg+xml', kind: 'svg' }],
    createdAt: 'c0',
    updatedAt: 'u1',
  };

  it('seeds the new node from the cached parent chain and the streamed text', () => {
    const client = new QueryClient();
    client.setQueryData(keys.chain('t', 'основы'), [parent]);
    seedDoneChain(client, done, '  Answer  ');
    expect(client.getQueryData(keys.chain('t', 'основы/ответ'))).toEqual([
      parent,
      {
        id: 'основы/ответ',
        name: 'ответ',
        created: 'u1',
        model: 'm2',
        user: 'Вопрос',
        assistant: 'Answer',
        attachments: done.attachments,
        files: done.files,
      },
    ]);
  });

  it('seeds under the root without a cached chain', () => {
    const client = new QueryClient();
    seedDoneChain(client, { ...done, parentId: '', nodeId: 'ответ' }, 'A');
    expect(client.getQueryData<ChainNode[]>(keys.chain('t', 'ответ'))?.map((n) => n.id)).toEqual([
      'ответ',
    ]);
  });

  it('skips when the parent chain is not cached', () => {
    const client = new QueryClient();
    seedDoneChain(client, done, 'A');
    expect(client.getQueryData(keys.chain('t', 'основы/ответ'))).toBeUndefined();
  });
});
