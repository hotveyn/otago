import { lookup as dnsLookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { isIP } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AttachmentError } from '../errors.js';

/** Server-side download policy for `save_attachment` URL inputs. */
export const URL_DOWNLOAD_POLICY = {
  protocols: ['http:', 'https:'],
  maxRedirects: 5,
  /** Until response headers arrive. */
  headersTimeoutMs: 30_000,
  /** Max gap between body chunks (no total cap: size is unlimited, streamed to disk). */
  idleTimeoutMs: 60_000,
  blockPrivateAddresses: true,
  allowPrivateEnv: 'OTAGO_ALLOW_PRIVATE_URLS',
} as const;

export interface DownloadPolicy {
  protocols: readonly string[];
  maxRedirects: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
}

export type LookupFn = (hostname: string) => Promise<string[]>;

export interface DownloadOptions {
  url: string;
  /** File to create; parent folder must exist. */
  target: string;
  signal: AbortSignal;
  /** Allow loopback/private/link-local addresses. */
  allowPrivate: boolean;
  /** Overrides for tests. */
  policy?: Partial<DownloadPolicy>;
  lookup?: LookupFn;
}

export interface DownloadResult {
  /** File name from `Content-Disposition` or the URL path (unsanitized). */
  suggestedName?: string;
  /** Response `Content-Type` without parameters. */
  contentType?: string;
  size: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultLookup: LookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Download `url` into `target`, streaming the body to disk.
 * Every hop (including redirects) is checked against the private-address blocklist.
 * DNS rebinding between the check and the connection (TOCTOU) is accepted: this is a local,
 * single-user app, and the check only guards against the agent reaching local services by
 * accident or by prompt injection through obvious URLs.
 * Throws `AttachmentError` with a short message on any failure.
 */
export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  const policy: DownloadPolicy = { ...URL_DOWNLOAD_POLICY, ...options.policy };
  const lookup = options.lookup ?? defaultLookup;
  let current = parseUrl(options.url, policy);

  for (let hop = 0; ; hop++) {
    if (!options.allowPrivate) await assertPublicHost(current, lookup);
    const timeout = new AbortController();
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    let timedOut: string | undefined;
    const expire = (message: string) => {
      timedOut = message;
      timeout.abort();
    };
    let timer = setTimeout(
      () => expire('Timed out waiting for the server response'),
      policy.headersTimeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await fetch(current, { redirect: 'manual', signal });
      } catch (error) {
        throw toAttachmentError(error, options.signal, timedOut);
      }
      clearTimeout(timer);

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new AttachmentError(`HTTP ${response.status} without Location`);
        if (hop >= policy.maxRedirects) throw new AttachmentError('Too many redirects');
        current = parseUrl(new URL(location, current).toString(), policy);
        continue;
      }
      if (response.status >= 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new AttachmentError(`HTTP ${response.status}`);
      }
      if (!response.body) throw new AttachmentError('Empty response body');

      let size = 0;
      const resetIdle = () => {
        clearTimeout(timer);
        timer = setTimeout(() => expire('Download stalled'), policy.idleTimeoutMs);
      };
      resetIdle();
      const idle = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          resetIdle();
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body as WebReadableStream<Uint8Array>, { signal }),
          idle,
          createWriteStream(options.target),
          { signal },
        );
      } catch (error) {
        throw toAttachmentError(error, options.signal, timedOut);
      }
      if (size === 0) throw new AttachmentError('Empty response body');
      return {
        suggestedName:
          fileNameFromContentDisposition(response.headers.get('content-disposition')) ??
          fileNameFromUrl(current),
        contentType: mediaTypeOf(response.headers.get('content-type')),
        size,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseUrl(raw: string, policy: DownloadPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AttachmentError('Invalid URL');
  }
  if (!policy.protocols.includes(url.protocol)) {
    throw new AttachmentError(`Unsupported URL scheme "${url.protocol}". Use http or https`);
  }
  return url;
}

function toAttachmentError(
  error: unknown,
  signal: AbortSignal,
  timedOut: string | undefined,
): AttachmentError {
  if (error instanceof AttachmentError) return error;
  if (signal.aborted) return new AttachmentError('Aborted');
  if (timedOut) return new AttachmentError(timedOut);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const message = error instanceof Error ? error.message : String(error);
  return new AttachmentError(`Download failed: ${cause || message}`);
}

async function assertPublicHost(url: URL, lookup: LookupFn): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new AttachmentError(`Could not resolve host "${host}"`);
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new AttachmentError(`Blocked private address for host "${host}"`);
  }
}

/** Loopback, private, link-local, CGNAT, unique-local, unspecified, multicast (v4/v6/mapped). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(parseIPv4(address));
  if (version === 6) {
    const groups = parseIPv6(address);
    if (!groups) return true;
    const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = groups;
    const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
    const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
    if (groups.every((g) => g === 0)) return true; // ::
    if (firstFiveZero && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1
    if (firstFiveZero && (g5 === 0xffff || g5 === 0)) return isPrivateIPv4(embedded); // mapped/compat
    if (g0 === 0x64 && groups[1] === 0xff9b) return isPrivateIPv4(embedded); // NAT64
    if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
    if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

function parseIPv4(address: string): number[] {
  return address.split('.').map(Number);
}

function isPrivateIPv4([a = 0, b = 0]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function parseIPv6(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = parseIPv4(dotted[1]);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail, ...rest] = text.split('::');
  if (rest.length > 0) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** `filename*=UTF-8''…` wins over `filename=`. */
export function fileNameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended?.[2]) {
    try {
      const value = decodeURIComponent(extended[2].trim().replace(/^"|"$/g, ''));
      if (value) return value;
    } catch {
      // Fall through to `filename=`.
    }
  }
  const plain = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]+))/i.exec(header);
  const value = (plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2])?.trim();
  return value || undefined;
}

/** Last non-empty path segment, decoded. */
export function fileNameFromUrl(url: URL): string | undefined {
  const segment = url.pathname.split('/').filter(Boolean).at(-1);
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function mediaTypeOf(header: string | null): string | undefined {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  return type || undefined;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/plain': '.txt',
  'application/json': '.json',
  'text/html': '.html',
};

/** Extension (with the dot) for a response media type, if known. */
export function extensionForContentType(contentType: string | undefined): string | undefined {
  return contentType ? EXTENSION_BY_TYPE[contentType] : undefined;
}
