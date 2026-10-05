import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, attachmentUrl, buildQuestionBody, isApiError, userFileUrl } from './client';
import type { QuestionInfo } from './types';

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const question: QuestionInfo = {
  id: '11111111-1111-4111-8111-111111111111',
  tree: 'tree',
  parentId: 'основы',
  context: { kind: 'main' },
  text: 'q',
  title: 'q',
  files: [],
  model: 'm',
  namingModel: 'n',
  attempt: 1,
  status: 'streaming',
  createdAt: '2026-10-04T00:00:00.000Z',
  updatedAt: '2026-10-04T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('questions api', () => {
  it('starts a question with a JSON body and resolves with the 202 question', async () => {
    const fetchMock = mockFetch(json({ question }, 202));
    const controller = new AbortController();
    const result = await api.startQuestion(
      'my tree',
      { parentId: 'основы', text: 'q', context: { kind: 'side', anchor: '' } },
      controller.signal,
    );
    expect(result).toEqual(question);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/trees/my%20tree/questions');
    expect(init.method).toBe('POST');
    expect(init.signal).toBe(controller.signal);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      parentId: 'основы',
      text: 'q',
      context: { kind: 'side', anchor: '' },
    });
  });

  it('starts a question with files as multipart', async () => {
    const fetchMock = mockFetch(json({ question }, 202));
    await api.startQuestion('t', {
      parentId: 'a',
      text: '',
      context: { kind: 'main' },
      files: [new File(['x'], 'a.pdf')],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it('cancels with DELETE and resolves on 204', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));
    await expect(api.cancelQuestion('a/b')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/questions/a%2Fb');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('retries with a bodiless POST and resolves with the question', async () => {
    const retried = { ...question, attempt: 2 };
    const fetchMock = mockFetch(json({ question: retried }, 202));
    await expect(api.retryQuestion(question.id)).resolves.toEqual(retried);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/questions/${question.id}/retry`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('maps upload rejections to ApiError', async () => {
    mockFetch(json({ error: '"big.pdf" is larger than 20 MB', code: 'file_too_large' }, 413));
    const error = (await api
      .startQuestion('t', { parentId: '', text: 'q', context: { kind: 'main' } })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(413);
    expect(error.code).toBe('file_too_large');
  });

  it('reads question error codes and keeps details for every status', async () => {
    mockFetch(json({ error: 'done', code: 'question_finished', details: { nodeId: 'a/b' } }, 409));
    let error = (await api.cancelQuestion(question.id).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('question_finished');
    expect(error.details).toEqual({ nodeId: 'a/b' });
    expect(isApiError(error, 409, 'question_finished')).toBe(true);
    expect(isApiError(error, 404)).toBe(false);

    mockFetch(json({ error: 'gone', code: 'question_not_found' }, 404));
    error = (await api.retryQuestion(question.id).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('question_not_found');
    expect(error.details).toBeUndefined();

    mockFetch(json({ error: 'busy', code: 'question_not_failed' }, 409));
    error = (await api.retryQuestion(question.id).catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('question_not_failed');
  });

  it('keeps busy details of a 409', async () => {
    const details = { questions: [], preparing: 1 };
    mockFetch(json({ error: 'busy', code: 'tree_busy_streaming', details }, 409));
    const error = (await api.deleteNodes('t', ['a']).catch((e: unknown) => e)) as ApiError;
    expect(error.details).toEqual(details);
  });
});

describe('attachments', () => {
  it('builds the contract URL with encoding', () => {
    expect(attachmentUrl('my tree', 'a/b c', 'x&y.svg')).toBe(
      '/api/trees/my%20tree/attachments?node=a%2Fb%20c&name=x%26y.svg',
    );
    expect(attachmentUrl('t', 'n', 'f.pdf', true)).toBe(
      '/api/trees/t/attachments?node=n&name=f.pdf&download=1',
    );
  });

  it('fetches attachment text and surfaces errors', async () => {
    mockFetch(new Response('a,b\n1,2'));
    await expect(api.getAttachmentText('t', 'n', 'x.csv')).resolves.toBe('a,b\n1,2');
    mockFetch(new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 }));
    await expect(api.getAttachmentText('t', 'n', 'x.csv')).rejects.toThrow('Attachment not found');
  });

  it('defaults chain attachments to []', async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          chain: [{ id: 'a', name: 'a', created: '', model: '', user: 'q', assistant: 'a' }],
        }),
      ),
    );
    const chain = await api.getChain('t', 'a');
    expect(chain[0]?.attachments).toEqual([]);
  });
});

describe('error codes', () => {
  const conflict = (body: unknown) =>
    mockFetch(new Response(JSON.stringify(body), { status: 409 }));

  it('reads a known 409 code', async () => {
    conflict({ error: 'Tree "t" is busy', code: 'tree_busy_structural' });
    const error = await api
      .startQuestion('t', { parentId: '', text: 'q', context: { kind: 'main' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).code).toBe('tree_busy_structural');
    expect((error as ApiError).message).toBe('Tree "t" is busy');
  });

  it('leaves code undefined when the server omits it', async () => {
    conflict({ error: 'Tree "t" is busy' });
    const error = (await api.deleteNodes('t', ['a']).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(409);
    expect(error.code).toBeUndefined();
  });

  it('ignores unknown codes', async () => {
    conflict({ error: 'busy', code: 'tree_on_fire' });
    const error = (await api.moveNodes('t', ['a'], '').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBeUndefined();
    expect(error.message).toBe('busy');
  });
});

describe('node management', () => {
  const ok = (body: unknown) => mockFetch(new Response(JSON.stringify(body), { status: 200 }));
  const sentBody = (fetchMock: ReturnType<typeof mockFetch>) => {
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return JSON.parse(init.body as string) as Record<string, unknown>;
  };

  it('restoreNodes posts trash ids and returns the body', async () => {
    const body = { restored: { 'a.deleted-1': 'a' }, nodes: [] };
    const fetchMock = ok(body);
    expect(await api.restoreNodes('my tree', ['a.deleted-1'])).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/trees/my%20tree/nodes/restore');
    expect(init.method).toBe('POST');
    expect(sentBody(fetchMock)).toEqual({ trashIds: ['a.deleted-1'] });
  });

  it('moveNodes sends names only when given', async () => {
    let fetchMock = ok({ moved: {}, nodes: [] });
    await api.moveNodes('t', ['x/a'], 'p', { 'x/a': 'a' });
    expect(sentBody(fetchMock)).toEqual({
      ids: ['x/a'],
      targetParentId: 'p',
      names: { 'x/a': 'a' },
    });
    fetchMock = ok({ moved: {}, nodes: [] });
    await api.moveNodes('t', ['x/a'], 'p');
    expect(sentBody(fetchMock)).not.toHaveProperty('names');
  });

  it('deleteNodes returns trash ids and the hierarchy', async () => {
    ok({ deleted: { a: 'a.deleted-1' }, nodes: [] });
    expect(await api.deleteNodes('t', ['a'])).toEqual({ deleted: { a: 'a.deleted-1' }, nodes: [] });
  });

  it('deleteNodes defaults deleted for an older server', async () => {
    ok({ nodes: [] });
    expect(await api.deleteNodes('t', ['a'])).toEqual({ deleted: {}, nodes: [] });
  });

  it('reads 404 codes', async () => {
    mockFetch(
      new Response(JSON.stringify({ error: 'gone', code: 'parent_not_found' }), { status: 404 }),
    );
    const error = (await api
      .restoreNodes('t', ['a.deleted-1'])
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(404);
    expect(error.code).toBe('parent_not_found');
  });

  it('renameNode posts id and name and returns the body', async () => {
    const body = {
      id: 'x/borrowing-rules',
      name: 'borrowing-rules',
      renamed: { 'x/b': 'x/borrowing-rules', 'x/b/c': 'x/borrowing-rules/c' },
      nodes: [],
    };
    const fetchMock = ok(body);
    expect(await api.renameNode('my tree', 'x/b', 'Borrowing Rules')).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/trees/my%20tree/nodes/rename');
    expect(init.method).toBe('POST');
    expect(sentBody(fetchMock)).toEqual({ id: 'x/b', name: 'Borrowing Rules' });
  });

  it('renameNode carries 409 and 404 codes', async () => {
    mockFetch(
      new Response(JSON.stringify({ error: 'busy', code: 'tree_busy_structural' }), {
        status: 409,
      }),
    );
    let error = (await api.renameNode('t', 'a', 'b').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(409);
    expect(error.code).toBe('tree_busy_structural');
    mockFetch(
      new Response(JSON.stringify({ error: 'gone', code: 'tree_not_found' }), { status: 404 }),
    );
    error = (await api.renameNode('t', 'a', 'b').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(404);
    expect(error.code).toBe('tree_not_found');
  });

  it('updateTree returns the new id and previous', async () => {
    const body = {
      id: 'rust',
      title: 'Rust',
      created: 'c',
      instructions: '',
      previous: { id: 'rust-basics', title: 'Rust basics' },
    };
    const fetchMock = ok(body);
    expect(await api.updateTree('rust-basics', { title: 'Rust' })).toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/trees/rust-basics');
    expect(init.method).toBe('PATCH');
    expect(sentBody(fetchMock)).toEqual({ title: 'Rust' });
  });

  it('updateTree defaults previous for an older server', async () => {
    ok({ id: 't', title: 'New', created: 'c', instructions: '' });
    expect(await api.updateTree('t', { title: 'New' })).toEqual({
      id: 't',
      title: 'New',
      created: 'c',
      instructions: '',
      previous: { id: 't', title: 'New' },
    });
  });

  it('ignores unknown 404 codes', async () => {
    mockFetch(new Response(JSON.stringify({ error: 'gone', code: 'nope' }), { status: 404 }));
    const error = (await api
      .restoreNodes('t', ['a.deleted-1'])
      .catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBeUndefined();
  });
});

const upload = (name: string, body = 'data', type = '') => new File([body], name, { type });

describe('buildQuestionBody', () => {
  it('sends JSON with the context without files', () => {
    const { body, headers } = buildQuestionBody({
      parentId: 'a',
      text: 'q',
      model: 'm',
      namingModel: undefined,
      context: { kind: 'main' },
      files: [],
    });
    expect(body).toBe('{"parentId":"a","text":"q","model":"m","context":{"kind":"main"}}');
    expect(headers).toEqual({ 'content-type': 'application/json' });
  });

  it('builds multipart with the payload (incl. context) first and one part per file', async () => {
    const { body, headers } = buildQuestionBody({
      parentId: 'a/b',
      text: '',
      model: 'm',
      context: { kind: 'side', anchor: 'a' },
      files: [upload('a.pdf'), upload('', 'png', 'image/png')],
    });
    expect(headers).toEqual({});
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect([...form.keys()]).toEqual(['payload', 'files', 'files']);
    expect(JSON.parse(form.get('payload') as string)).toEqual({
      parentId: 'a/b',
      text: '',
      model: 'm',
      context: { kind: 'side', anchor: 'a' },
    });
    const files = form.getAll('files') as File[];
    expect(files.map((f) => f.name)).toEqual(['a.pdf', '']);
    expect(files[1]?.type).toBe('image/png');
    await expect(files[0]?.text()).resolves.toBe('data');
  });
});

describe('user files', () => {
  it('builds the files URL with encoding and leaves attachmentUrl unchanged', () => {
    expect(userFileUrl('my tree', 'a/b c', 'x&y.png')).toBe(
      '/api/trees/my%20tree/files?node=a%2Fb%20c&name=x%26y.png',
    );
    expect(userFileUrl('t', 'n', 'f.pdf', true)).toBe(
      '/api/trees/t/files?node=n&name=f.pdf&download=1',
    );
    expect(attachmentUrl('t', 'n', 'f.pdf')).toBe('/api/trees/t/attachments?node=n&name=f.pdf');
  });

  it('defaults chain files to []', async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          chain: [{ id: 'a', name: 'a', created: '', model: '', user: '', assistant: 'a' }],
        }),
      ),
    );
    const chain = await api.getChain('t', 'a');
    expect(chain[0]?.files).toEqual([]);
  });

  it('fetches from the files folder when asked', async () => {
    const fetchMock = mockFetch(new Response('# book'));
    await expect(api.getAttachmentText('t', 'n', 'b.epub.md', 'files')).resolves.toBe('# book');
    expect(fetchMock).toHaveBeenCalledWith('/api/trees/t/files?node=n&name=b.epub.md');
  });
});
