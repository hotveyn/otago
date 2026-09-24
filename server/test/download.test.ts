import { readdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadToFile,
  fileNameFromContentDisposition,
  isPrivateAddress,
} from '../src/storage/index.js';
import { makeTempDir } from './helpers.js';

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const hop = Number(url.searchParams.get('n') ?? 0);
    switch (url.pathname) {
      case '/files/report%20v1.pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end('%PDF-1.7');
      case '/named':
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="fallback.csv"; filename*=UTF-8''%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.csv`,
        });
        return res.end('a,b\n1,2\n');
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/redirect':
        res.writeHead(302, {
          location: hop > 1 ? `redirect?n=${hop - 1}` : '/files/report%20v1.pdf',
        });
        return res.end();
      case '/missing':
        res.writeHead(404);
        return res.end('nope');
      case '/empty':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end();
      case '/stall':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
        return; // never ends
      case '/slow-headers':
        return; // never responds
      default:
        res.writeHead(500);
        return res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('downloadToFile', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(() => cleanup());

  const target = () => path.join(dir, 'out.part');
  const get = (url: string, extra: Partial<Parameters<typeof downloadToFile>[0]> = {}) =>
    downloadToFile({
      url,
      target: target(),
      signal: new AbortController().signal,
      allowPrivate: true,
      ...extra,
    });

  it('streams the body to the file and names it from the URL path', async () => {
    const result = await get(`${base}/files/report%20v1.pdf`);
    expect(result).toEqual({
      suggestedName: 'report v1.pdf',
      contentType: 'application/pdf',
      size: 8,
    });
    expect(await readFile(target(), 'utf8')).toBe('%PDF-1.7');
  });

  it('prefers the Content-Disposition file name', async () => {
    const result = await get(`${base}/named`);
    expect(result.suggestedName).toBe('данные.csv');
    expect(result.contentType).toBe('text/csv');
  });

  it('follows redirects, resolving relative locations', async () => {
    const result = await get(`${base}/redirect?n=3`);
    expect(result.suggestedName).toBe('report v1.pdf');
  });

  it('fails after too many redirects', async () => {
    await expect(get(`${base}/redirect?n=6`)).rejects.toThrow('Too many redirects');
  });

  it('reports HTTP errors and empty bodies', async () => {
    await expect(get(`${base}/missing`)).rejects.toThrow('HTTP 404');
    await expect(get(`${base}/empty`)).rejects.toThrow('Empty response body');
  });

  it('rejects non-http schemes and invalid URLs', async () => {
    await expect(get('ftp://example.com/a.txt')).rejects.toThrow(/Unsupported URL scheme/);
    await expect(get('file:///etc/passwd')).rejects.toThrow(/Unsupported URL scheme/);
    await expect(get('not a url')).rejects.toThrow('Invalid URL');
  });

  it('times out on stalled bodies and slow headers', async () => {
    await expect(get(`${base}/stall`, { policy: { idleTimeoutMs: 100 } })).rejects.toThrow(
      'Download stalled',
    );
    await expect(
      get(`${base}/slow-headers`, { policy: { headersTimeoutMs: 100 } }),
    ).rejects.toThrow(/Timed out/);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    const pending = get(`${base}/stall`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow('Aborted');
  });

  it('blocks private addresses unless allowed', async () => {
    const port = new URL(base).port;
    await expect(get(`${base}/image`, { allowPrivate: false })).rejects.toThrow(
      /Blocked private address/,
    );
    await expect(get(`http://localhost:${port}/image`, { allowPrivate: false })).rejects.toThrow(
      /Blocked private address/,
    );
    await expect(get('http://[::1]/image', { allowPrivate: false })).rejects.toThrow(
      /Blocked private address/,
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it('checks every redirect hop', async () => {
    // The fake lookup says "localhost" is public, so only the redirect target gets blocked.
    const port = new URL(base).port;
    const lookups: string[] = [];
    const lookup = async (host: string) => {
      lookups.push(host);
      return host === 'localhost' ? ['93.184.216.34'] : ['10.0.0.1'];
    };
    const redirector = http.createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/image` });
      res.end();
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
    const redirectorPort = (redirector.address() as AddressInfo).port;
    let hits = 0;
    redirector.on('request', () => hits++);
    const blocked = (url: string) =>
      downloadToFile({
        url,
        target: target(),
        signal: new AbortController().signal,
        allowPrivate: false,
        lookup,
      });
    try {
      await expect(blocked(`http://localhost:${redirectorPort}/`)).rejects.toThrow(
        'Blocked private address for host "127.0.0.1"',
      );
      expect(hits).toBe(1);
    } finally {
      await new Promise((resolve) => redirector.close(resolve));
    }
    await expect(blocked('http://internal.test/x')).rejects.toThrow(
      'Blocked private address for host "internal.test"',
    );
    expect(lookups).toEqual(['localhost', 'internal.test']);
  });
});

describe('address classification', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['::', true],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700::1111', false],
    ['not-an-ip', true],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('Content-Disposition parsing', () => {
  it.each([
    ['attachment; filename="a b.pdf"', 'a b.pdf'],
    ['inline; filename=plain.txt', 'plain.txt'],
    [`attachment; filename="x.csv"; filename*=UTF-8''r%C3%A9sum%C3%A9.csv`, 'résumé.csv'],
    ['attachment', undefined],
  ])('%s → %s', (header, expected) => {
    expect(fileNameFromContentDisposition(header)).toBe(expected);
  });
});
