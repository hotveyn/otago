import { describe, expect, it } from 'vitest';
import {
  type AttachmentStaging,
  createAttachmentMcpServer,
  createSaveAttachmentHandler,
  decodeBase64,
} from '../src/agent/index.js';
import { AttachmentError } from '../src/errors.js';
import { attachmentContentTypeOf, attachmentKindOf } from '../src/storage/index.js';

interface Call {
  method: 'bytes' | 'url';
  name?: string;
  data?: Uint8Array;
  url?: string;
}

function fakeStaging(fail?: string): AttachmentStaging & { calls: Call[] } {
  const calls: Call[] = [];
  const info = (name: string, size: number) => ({
    name,
    size,
    contentType: attachmentContentTypeOf(name),
    kind: attachmentKindOf(name),
  });
  return {
    calls,
    async saveFromBytes({ name, data, origin }) {
      calls.push({ method: 'bytes', name, data });
      if (fail) throw new AttachmentError(fail);
      return { ...info(name, data.byteLength), origin };
    },
    async saveFromUrl({ url, name }) {
      calls.push({ method: 'url', name, url });
      if (fail) throw new AttachmentError(fail);
      return { ...info(name ?? 'download.png', 10), origin: 'url' };
    },
    async saveFromStream() {
      throw new Error('not used');
    },
  };
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? '';

describe('save_attachment handler', () => {
  it('saves utf8 content and returns the reference path', async () => {
    const staging = fakeStaging();
    const result = await createSaveAttachmentHandler(staging)({
      name: 'memory-layout.svg',
      content: '<svg/>',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({
      name: 'memory-layout.svg',
      path: 'attachments/memory-layout.svg',
      size: 6,
      contentType: 'image/svg+xml',
      kind: 'svg',
    });
    expect(Buffer.from(staging.calls[0]?.data ?? []).toString()).toBe('<svg/>');
  });

  it('decodes base64 content', async () => {
    const staging = fakeStaging();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const result = await createSaveAttachmentHandler(staging)({
      name: 'pic.png',
      content: `${png.toString('base64').slice(0, 4)}\n${png.toString('base64').slice(4)}`,
      encoding: 'base64',
    });
    expect(result.isError).toBeUndefined();
    expect(Buffer.from(staging.calls[0]?.data ?? [])).toEqual(png);
  });

  it.each([
    ['not base64!', 'Invalid base64 content'],
    ['abc', 'Invalid base64 content'],
    ['', 'Empty content'],
  ])('base64 %j → isError %s', async (content, message) => {
    const staging = fakeStaging();
    const result = await createSaveAttachmentHandler(staging)({
      name: 'a.bin',
      content,
      encoding: 'base64',
    });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: message }] });
    expect(staging.calls).toEqual([]);
  });

  it('requires exactly one of content or url, and a name with content', async () => {
    const handler = createSaveAttachmentHandler(fakeStaging());
    expect(await handler({ name: 'a.txt', content: 'x', url: 'https://x' })).toMatchObject({
      isError: true,
    });
    expect(textOf(await handler({ name: 'a.txt' }))).toContain('exactly one');
    expect(textOf(await handler({ content: 'x' }))).toContain('`name` is required');
    expect(textOf(await handler({ name: '  ', content: 'x' }))).toContain('`name` is required');
  });

  it('downloads URLs with an optional name', async () => {
    const staging = fakeStaging();
    const handler = createSaveAttachmentHandler(staging);
    const result = await handler({ url: 'https://example.com/a.png' });
    expect(JSON.parse(textOf(result))).toMatchObject({ path: 'attachments/download.png' });
    await handler({ url: 'https://example.com/b', name: 'photo.jpg' });
    expect(staging.calls).toEqual([
      { method: 'url', url: 'https://example.com/a.png', name: undefined },
      { method: 'url', url: 'https://example.com/b', name: 'photo.jpg' },
    ]);
  });

  it('turns staging errors into isError results without throwing', async () => {
    const handler = createSaveAttachmentHandler(fakeStaging('HTTP 404'));
    expect(await handler({ url: 'https://example.com/x' })).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'HTTP 404' }],
    });
    const crashing = createSaveAttachmentHandler({
      ...fakeStaging(),
      saveFromBytes: () => Promise.reject(new Error('disk full')),
    });
    expect(await crashing({ name: 'a.txt', content: 'x' })).toMatchObject({
      isError: true,
      content: [{ text: 'disk full' }],
    });
  });

  it('decodeBase64 accepts padded input', () => {
    expect(Buffer.from(decodeBase64('aGk=')).toString()).toBe('hi');
  });

  it('builds the in-process MCP server', () => {
    const server = createAttachmentMcpServer(fakeStaging());
    expect(server).toMatchObject({ type: 'sdk', name: 'otago' });
    expect(server.instance).toBeDefined();
  });
});
