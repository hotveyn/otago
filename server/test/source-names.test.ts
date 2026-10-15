import { describe, expect, it } from 'vitest';
import { isSourceFileName } from '../src/storage/source-names.js';

describe('isSourceFileName', () => {
  it('accepts Unicode letters, spaces and common punctuation', () => {
    for (const name of [
      'the-book-ch4.md',
      'Высоконагруженные приложения. Программирование, масштабирование (Клеппман).pdf',
      "O'Reilly & Co + notes.txt",
      'ｶﾀｶﾅ 日本語.epub',
      'עברית.fb2.zip',
      'é'.normalize('NFD') + '.md',
    ]) {
      expect(isSourceFileName(name), name).toBe(true);
    }
  });

  it('rejects path separators, control chars, dots and overlong names', () => {
    for (const name of [
      '',
      '.hidden.md',
      '-a.md',
      'a/b.md',
      'a\\b.md',
      'a:b.md',
      'a..b.md',
      'a.md.',
      'a.md ',
      'a\u0000.md',
      'a\u200b.md',
      'a\nb.md',
      `${'a'.repeat(201)}`,
      `${'я'.repeat(121)}`, // 242 bytes
    ]) {
      expect(isSourceFileName(name), JSON.stringify(name)).toBe(false);
    }
    expect(isSourceFileName(`${'a'.repeat(200)}`)).toBe(true);
    expect(isSourceFileName(`${'я'.repeat(120)}`)).toBe(true);
  });
});
