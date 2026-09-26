import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, attachmentUrl, buildMessageBody, sendMessage, userFileUrl } from './client';
import type { AttachmentEvent } from './types';

function sseResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const input = () => ({
  treeId: 'tree',
  parentId: '',
  text: 'q',
  signal: new AbortController().signal,
  onChunk: vi.fn(),
  onAttachment: vi.fn(),
});

const svg = { name: 'x.svg', size: 10, contentType: 'image/svg+xml', kind: 'svg' as const };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendMessage', () => {
  it('dispatches chunk and attachment events and resolves with done', async () => {
    const saving: AttachmentEvent = {
      status: 'saving',
      key: 'k',
      requestedName: 'x.svg',
      origin: 'inline',
    };
    const ready: AttachmentEvent = {
      status: 'ready',
      key: 'k',
      attachment: { ...svg, origin: 'inline' },
    };
    const fetchMock = mockFetch(
      sseResponse([
        event('chunk', 'Hel'),
        event('attachment', saving).slice(0, 10),
        event('attachment', saving).slice(10),
        event('chunk', 'lo'),
        event('attachment', ready),
        event('done', { nodeId: 'a/b', attachments: [svg] }),
      ]),
    );
    const args = input();
    const done = await sendMessage(args);
    expect(done).toEqual({ nodeId: 'a/b', attachments: [svg], files: [] });
    expect(args.onChunk.mock.calls).toEqual([['Hel'], ['lo']]);
    expect(args.onAttachment.mock.calls).toEqual([[saving], [ready]]);
    expect(fetchMock).toHaveBeenCalledWith('/api/trees/tree/messages', expect.anything());
  });

  it('defaults missing done.attachments and done.files to []', async () => {
    mockFetch(sseResponse([event('done', { nodeId: 'n' })]));
    await expect(sendMessage(input())).resolves.toEqual({
      nodeId: 'n',
      attachments: [],
      files: [],
    });
  });

  it('ignores unknown events', async () => {
    mockFetch(
      sseResponse([
        'event: progress\ndata: not json\n\n',
        event('done', { nodeId: 'n', attachments: [] }),
      ]),
    );
    await expect(sendMessage(input())).resolves.toEqual({
      nodeId: 'n',
      attachments: [],
      files: [],
    });
  });

  it('throws ApiError on an error event', async () => {
    mockFetch(sseResponse([event('chunk', 'x'), event('error', { message: 'boom' })]));
    const promise = sendMessage(input());
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(sendMessage(input())).rejects.toThrow();
  });

  it('throws when the stream ends without done', async () => {
    mockFetch(sseResponse([event('chunk', 'x')]));
    await expect(sendMessage(input())).rejects.toThrow('Stream ended without an answer');
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
    const error = await sendMessage(input()).catch((e: unknown) => e);
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

const upload = (name: string, body = 'data', type = '') => new File([body], name, { type });

const pdfInfo = { name: 'a.pdf', size: 4, contentType: 'application/pdf', kind: 'pdf' as const };

describe('buildMessageBody', () => {
  it('keeps the JSON body without files', () => {
    const { body, headers } = buildMessageBody({
      parentId: 'a',
      text: 'q',
      model: 'm',
      namingModel: undefined,
      files: [],
    });
    expect(body).toBe('{"parentId":"a","text":"q","model":"m"}');
    expect(headers).toEqual({ 'content-type': 'application/json' });
  });

  it('builds multipart with the payload first and one part per file', async () => {
    const { body, headers } = buildMessageBody({
      parentId: 'a/b',
      text: '',
      model: 'm',
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
    });
    const files = form.getAll('files') as File[];
    expect(files.map((f) => f.name)).toEqual(['a.pdf', '']);
    expect(files[1]?.type).toBe('image/png');
    await expect(files[0]?.text()).resolves.toBe('data');
  });
});

describe('sendMessage with files', () => {
  it('posts FormData, fires onAccepted before the stream and passes done.files through', async () => {
    const order: string[] = [];
    const fetchMock = mockFetch(
      sseResponse([
        event('chunk', 'x'),
        event('done', { nodeId: 'n', attachments: [], files: [pdfInfo] }),
      ]),
    );
    const args = {
      ...input(),
      text: '',
      files: [upload('a.pdf')],
      onChunk: vi.fn(() => order.push('chunk')),
      onAccepted: vi.fn(() => order.push('accepted')),
    };
    const done = await sendMessage(args);
    expect(done.files).toEqual([pdfInfo]);
    expect(args.onAccepted).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['accepted', 'chunk']);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has('content-type')).toBe(false);
  });

  it.each([
    [400, 'unsupported_file_type', 'Unsupported file type "notes.docx". Allowed: .md'],
    [413, 'file_too_large', '"big.pdf" is larger than 20 MB'],
  ])('maps a %i %s rejection to ApiError', async (status, code, message) => {
    mockFetch(new Response(JSON.stringify({ error: message, code }), { status }));
    const args = { ...input(), files: [upload('a.pdf')], onAccepted: vi.fn() };
    const error = (await sendMessage(args).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(status);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(args.onAccepted).not.toHaveBeenCalled();
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
