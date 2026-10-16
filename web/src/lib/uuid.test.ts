import { describe, expect, it } from 'vitest';
import { randomUuid } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomUuid', () => {
  it('uses crypto.randomUUID when it exists', () => {
    expect(randomUuid()).toMatch(V4);
  });

  it('falls back to getRandomValues outside a secure context', () => {
    const insecure = {
      getRandomValues: (array: Uint8Array<ArrayBuffer>) => crypto.getRandomValues(array),
    } as unknown as Crypto;
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid(insecure)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it('sets the version and variant bits', () => {
    const zeros = { getRandomValues: (array: Uint8Array) => array } as unknown as Crypto;
    expect(randomUuid(zeros)).toBe('00000000-0000-4000-8000-000000000000');
  });
});
