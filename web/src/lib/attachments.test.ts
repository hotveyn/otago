import { describe, expect, it } from 'vitest';
import type { AttachmentInfo } from '../api/types';
import {
  type AttachmentScopeValue,
  applyAttachmentEvent,
  canPreview,
  formatBytes,
  PREVIEW_LIMITS,
  parseAttachmentHref,
  resolveAttachment,
  type StreamingAttachment,
} from './attachments';

const svg: AttachmentInfo = {
  name: 'layout.svg',
  size: 1200,
  contentType: 'image/svg+xml',
  kind: 'svg',
};

describe('parseAttachmentHref', () => {
  it('extracts and decodes names', () => {
    expect(parseAttachmentHref('attachments/a.svg')).toBe('a.svg');
    expect(parseAttachmentHref('./attachments/a%20b.csv')).toBe('a b.csv');
  });

  it('rejects other hrefs', () => {
    expect(parseAttachmentHref('https://x.dev/attachments/a.svg')).toBeNull();
    expect(parseAttachmentHref('sources/a.md')).toBeNull();
    expect(parseAttachmentHref('attachments/')).toBeNull();
    expect(parseAttachmentHref('attachments/a/b.png')).toBeNull();
    expect(parseAttachmentHref('attachments/%E0%A4%A')).toBeNull();
    expect(parseAttachmentHref(undefined)).toBeNull();
  });
});

describe('applyAttachmentEvent', () => {
  it('keeps first-seen order and moves saving -> ready | failed', () => {
    let list: StreamingAttachment[] = [];
    list = applyAttachmentEvent(list, {
      status: 'saving',
      key: 'a',
      requestedName: 'x.svg',
      origin: 'inline',
    });
    list = applyAttachmentEvent(list, { status: 'saving', key: 'b', origin: 'url' });
    list = applyAttachmentEvent(list, { status: 'failed', key: 'b', message: 'HTTP 404' });
    list = applyAttachmentEvent(list, {
      status: 'ready',
      key: 'a',
      attachment: { ...svg, name: 'x.svg', origin: 'inline' },
    });
    expect(list.map((item) => [item.key, item.status])).toEqual([
      ['a', 'ready'],
      ['b', 'failed'],
    ]);
    expect(list[0]?.requestedName).toBe('x.svg');
    expect(list[0]?.attachment?.name).toBe('x.svg');
    expect(list[1]).toMatchObject({ origin: 'url', message: 'HTTP 404' });
  });

  it('inserts unknown keys on ready/failed', () => {
    const list = applyAttachmentEvent([], { status: 'ready', key: 'z', attachment: svg });
    expect(list).toEqual([{ key: 'z', status: 'ready', origin: undefined, attachment: svg }]);
    const failed = applyAttachmentEvent(list, {
      status: 'failed',
      key: 'y',
      requestedName: 'q.png',
      message: 'bad',
    });
    expect(failed.map((item) => item.key)).toEqual(['z', 'y']);
  });

  it('does not mutate the input', () => {
    const list: StreamingAttachment[] = [{ key: 'a', status: 'saving' }];
    applyAttachmentEvent(list, { status: 'ready', key: 'a', attachment: svg });
    expect(list[0]?.status).toBe('saving');
  });
});

describe('resolveAttachment', () => {
  const committed: AttachmentScopeValue = {
    treeId: 't 1',
    nodeId: 'a/b',
    attachments: [svg],
    streaming: null,
  };
  const streaming: AttachmentScopeValue = {
    treeId: 't',
    nodeId: null,
    attachments: [],
    streaming: [
      { key: '1', status: 'ready', attachment: svg },
      { key: '2', status: 'failed', requestedName: 'bad.png', message: 'Invalid base64' },
      { key: '3', status: 'saving', requestedName: 'wip.csv' },
    ],
  };

  it('resolves committed attachments with a URL', () => {
    expect(resolveAttachment(committed, 'layout.svg')).toEqual({
      state: 'ready',
      info: svg,
      url: '/api/trees/t%201/attachments?node=a%2Fb&name=layout.svg',
    });
  });

  it('reports missing committed attachments', () => {
    expect(resolveAttachment(committed, 'typo.png')).toEqual({ state: 'missing' });
  });

  it('resolves streaming states', () => {
    expect(resolveAttachment(streaming, 'layout.svg')).toEqual({ state: 'staged', info: svg });
    expect(resolveAttachment(streaming, 'bad.png')).toEqual({
      state: 'failed',
      message: 'Invalid base64',
    });
    expect(resolveAttachment(streaming, 'wip.csv')).toEqual({ state: 'saving' });
    expect(resolveAttachment(streaming, 'later.png')).toEqual({ state: 'saving' });
  });

  it('reports unknown names as missing once an answer was not saved', () => {
    expect(resolveAttachment({ ...streaming, unsaved: true }, 'later.png')).toEqual({
      state: 'missing',
    });
  });
});

describe('canPreview', () => {
  it('respects the per-kind limits', () => {
    expect(canPreview(svg)).toBe(true);
    expect(canPreview({ ...svg, size: PREVIEW_LIMITS.imageBytes + 1 })).toBe(false);
    const table = { ...svg, kind: 'table' as const };
    expect(canPreview({ ...table, size: PREVIEW_LIMITS.tableBytes })).toBe(true);
    expect(canPreview({ ...table, size: PREVIEW_LIMITS.tableBytes + 1 })).toBe(false);
    const text = { ...svg, kind: 'text' as const };
    expect(canPreview({ ...text, size: PREVIEW_LIMITS.textBytes + 1 })).toBe(false);
    const pdf = { ...svg, kind: 'pdf' as const };
    expect(canPreview({ ...pdf, size: PREVIEW_LIMITS.pdfBytes })).toBe(true);
    expect(canPreview({ ...svg, kind: 'other' })).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
