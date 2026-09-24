import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, attachmentUrl, sendMessage } from './client';
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
    expect(done).toEqual({ nodeId: 'a/b', attachments: [svg] });
    expect(args.onChunk.mock.calls).toEqual([['Hel'], ['lo']]);
    expect(args.onAttachment.mock.calls).toEqual([[saving], [ready]]);
    expect(fetchMock).toHaveBeenCalledWith('/api/trees/tree/messages', expect.anything());
  });

  it('defaults missing done.attachments to []', async () => {
    mockFetch(sseResponse([event('done', { nodeId: 'n' })]));
    await expect(sendMessage(input())).resolves.toEqual({ nodeId: 'n', attachments: [] });
  });

  it('ignores unknown events', async () => {
    mockFetch(
      sseResponse([
        'event: progress\ndata: not json\n\n',
        event('done', { nodeId: 'n', attachments: [] }),
      ]),
    );
    await expect(sendMessage(input())).resolves.toEqual({ nodeId: 'n', attachments: [] });
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
