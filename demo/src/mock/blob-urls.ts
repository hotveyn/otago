/**
 * Synchronous URLs for VFS files (`<img src>`, `<a download>`, `<iframe src>`): `blob:` URLs
 * cached per path and file version. A changed file gets a new URL; the old one is revoked.
 */
import type { Vfs } from './vfs';

const MISSING = -1;

export class BlobUrls {
  private readonly cache = new Map<string, { version: number; url: string }>();

  constructor(private readonly vfs: Vfs) {}

  url(path: string, contentType: string): string {
    const version = this.vfs.stat(path)?.version ?? MISSING;
    const cached = this.cache.get(path);
    if (cached?.version === version) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const bytes = this.vfs.readBytes(path);
    const blob = bytes
      ? new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType })
      : new Blob([`Not found: ${path}`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    this.cache.set(path, { version, url });
    return url;
  }
}
