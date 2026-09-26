import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EBOOK_EXTENSIONS } from '../src/storage/ebooks/index.js';
import { uniqueFileName } from '../src/storage/fs-utils.js';
import {
  createUserFileStager,
  DEFAULT_PASTED_STEM,
  IMAGE_MIME_EXTENSIONS,
  listUserFiles,
  MAX_MESSAGE_FILES,
  MESSAGE_FILE_EXTENSIONS,
  MESSAGE_IMAGE_EXTENSIONS,
  nodePromptFiles,
  resolveUserFileName,
  TEXT_SOURCE_EXTENSIONS,
  USER_FILE_NAME_PATTERN,
  userFileExtensionOf,
  userFileName,
  userFilePath,
} from '../src/storage/index.js';
import { fb2Book, makeTempDir, pngBytes } from './helpers.js';

const nameOf = (filename: string, mimetype = 'application/octet-stream') => {
  const { stem, ext } = resolveUserFileName(filename, mimetype);
  return userFileName(stem, ext);
};

describe('user file constants', () => {
  it('allows the sources set plus images', () => {
    expect([...MESSAGE_FILE_EXTENSIONS].sort()).toEqual(
      [...TEXT_SOURCE_EXTENSIONS, ...EBOOK_EXTENSIONS, ...MESSAGE_IMAGE_EXTENSIONS].sort(),
    );
    expect(Object.values(IMAGE_MIME_EXTENSIONS).every((ext) => ext.startsWith('.'))).toBe(true);
    expect(MAX_MESSAGE_FILES).toBe(10);
  });
});

describe('extension matching and naming', () => {
  it('matches the longest suffix case-insensitively', () => {
    expect(userFileExtensionOf('book.FB2.zip')).toBe('.fb2.zip');
    expect(userFileExtensionOf('book.fb2')).toBe('.fb2');
    expect(userFileExtensionOf('x.zip')).toBeUndefined();
    expect(userFileExtensionOf('x.azw3')).toBe('.azw3');
  });

  it('rejects unsupported types, listing the allowed ones', () => {
    for (const name of ['x.zip', 'notes.docx', 'script.js', 'noext']) {
      expect(() => resolveUserFileName(name, 'application/octet-stream'), name).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'unsupported_file_type' }),
      );
    }
    expect(() => resolveUserFileName('notes.docx', 'x')).toThrow(
      'Unsupported file type "notes.docx". Allowed: .fb2.zip, .md, .txt',
    );
  });

  it('lowercases the stored extension and keeps the stem', () => {
    expect(nameOf('A.PDF')).toBe('A.pdf');
    expect(nameOf('Photo.PNG')).toBe('Photo.png');
    expect(nameOf('Book.FB2.ZIP')).toBe('Book.fb2.zip');
  });

  it('uses the pasted stem when nothing usable is left', () => {
    expect(nameOf('.png')).toBe(`${DEFAULT_PASTED_STEM}.png`);
    expect(nameOf('🖼.png')).toBe(`${DEFAULT_PASTED_STEM}.png`);
    expect(nameOf('', 'image/png')).toBe(`${DEFAULT_PASTED_STEM}.png`);
    expect(nameOf('.md')).toBe('file.md');
  });

  it('uses the MIME type only for images', () => {
    expect(nameOf('clipboard', 'image/png')).toBe('clipboard.png');
    expect(nameOf('shot', 'image/jpeg')).toBe('shot.jpg');
    expect(() => resolveUserFileName('doc', 'application/pdf')).toThrow(
      expect.objectContaining({ code: 'unsupported_file_type' }),
    );
    // The MIME type makes it a PNG name; the magic-byte check still decides (see stager).
    expect(nameOf('evil.exe', 'image/png')).toBe('evil.png');
  });

  it('sanitizes traversal, unicode and long names', () => {
    expect(nameOf('../../x.md')).toBe('x.md');
    expect(nameOf('a\\b\\c.txt')).toBe('c.txt');
    expect(nameOf('Résumé 1.txt')).toBe('Resume-1.txt');
    const long = nameOf(`${'a'.repeat(300)}.md`);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.md')).toBe(true);
    const book = nameOf(`${'b'.repeat(300)}.epub`);
    expect(`${book}.md`.length).toBeLessThanOrEqual(120);
    for (const name of [long, book]) expect(USER_FILE_NAME_PATTERN.test(name)).toBe(true);
  });

  it('puts the -N suffix before a compound extension', () => {
    expect(uniqueFileName(new Set(['book.fb2.zip']), 'book.fb2.zip', 120, '.fb2.zip')).toBe(
      'book-2.fb2.zip',
    );
    expect(uniqueFileName(new Set(['book.fb2.zip']), 'book.fb2.zip')).toBe('book.fb2-2.zip');
    expect(uniqueFileName(new Set(['a.png']), 'a.png', 120, '.png')).toBe('a-2.png');
  });
});

describe('user file stager', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let stagingDir: string;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
    stagingDir = path.join(dir, 'tree', '.tmp-answer-x');
    await mkdir(stagingDir, { recursive: true });
  });
  afterEach(() => cleanup());

  const filesDir = () => path.join(stagingDir, 'files');
  const entries = async () => (await readdir(filesDir()).catch(() => [] as string[])).sort();
  const stager = (signal = new AbortController().signal) =>
    createUserFileStager({ stagingDir, signal });
  const add = (
    s: ReturnType<typeof stager>,
    filename: string,
    content: string | Uint8Array,
    mimetype = 'application/octet-stream',
  ) =>
    s.addFromStream({
      filename,
      mimetype,
      stream: Readable.from([Buffer.from(content)]),
    });

  it('stages files with unique names in arrival order', async () => {
    const s = stager();
    await add(s, 'a.png', pngBytes());
    await add(s, 'a.png', pngBytes());
    await add(s, 'notes.md', '# Notes');
    expect(s.list().map((f) => f.name)).toEqual(['a.png', 'a-2.png', 'notes.md']);
    expect(s.list()[2]).toEqual({
      name: 'notes.md',
      size: 7,
      contentType: 'text/markdown; charset=utf-8',
      kind: 'text',
    });
    expect(await entries()).toEqual(['a-2.png', 'a.png', 'notes.md']);
  });

  it('reserves e-book companions', async () => {
    const s = stager();
    await add(s, 'book.fb2', fb2Book());
    await add(s, 'book.fb2.md', '# mine');
    await add(s, 'x.fb2.zip', 'x'.repeat(10)).catch(() => undefined);
    expect(s.list().map((f) => [f.name, f.text])).toEqual([
      ['book.fb2', 'book.fb2.md'],
      ['book.fb2-2.md', undefined],
    ]);
    const other = stager();
    await add(other, 'c.fb2.md', '# first');
    await add(other, 'c.fb2', fb2Book());
    expect(other.list().map((f) => f.name)).toEqual(['c.fb2.md', 'c-2.fb2']);
    expect(other.list()[1]?.text).toBe('c-2.fb2.md');
  });

  it('extracts e-book text with a files/ header', async () => {
    const s = stager();
    const info = await add(s, 'Tiny.fb2', fb2Book());
    expect(info).toMatchObject({
      name: 'Tiny.fb2',
      text: 'Tiny.fb2.md',
      kind: 'other',
      contentType: 'application/x-fictionbook+xml',
    });
    const markdown = await readFile(path.join(filesDir(), 'Tiny.fb2.md'), 'utf8');
    expect(markdown).toContain('<!-- Text extracted by Otago from files/Tiny.fb2 -->');
    expect(markdown).toContain('Borrowing is referencing.');
  });

  it('rejects an unreadable e-book and leaves nothing behind', async () => {
    const s = stager();
    await expect(add(s, 'Broken.EPUB', 'not a zip')).rejects.toMatchObject({
      statusCode: 400,
      code: 'unreadable_file',
      message: expect.stringContaining('Cannot read Broken.EPUB'),
    });
    expect(await entries()).toEqual([]);
    expect(s.list()).toEqual([]);
  });

  it('rejects empty files and bad signatures', async () => {
    const s = stager();
    await expect(add(s, 'empty.txt', '')).rejects.toMatchObject({
      code: 'empty_file',
      message: '"empty.txt" is empty',
    });
    await expect(add(s, 'evil.exe', 'MZ not a png', 'image/png')).rejects.toMatchObject({
      code: 'unreadable_file',
      message: '"evil.exe" is not a valid PNG file',
    });
    for (const [name, content] of [
      ['a.jpg', 'nope'],
      ['a.gif', 'GIF00a'],
      ['a.webp', 'RIFF0000WEBX'],
      ['a.pdf', 'hello'],
    ] as const) {
      await expect(add(s, name, content), name).rejects.toMatchObject({ code: 'unreadable_file' });
    }
    await add(s, 'ok.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await add(s, 'ok.gif', 'GIF89a...');
    await add(s, 'ok.webp', 'RIFF1234WEBPVP8 ');
    await add(s, 'ok.pdf', '%PDF-1.7');
    expect(await entries()).toEqual(['ok.gif', 'ok.jpg', 'ok.pdf', 'ok.webp']);
  });

  it('rejects a truncated (over the cap) stream with 413', async () => {
    const s = stager();
    const stream = Object.assign(Readable.from([Buffer.from('%PDF-1.7 lots')]), {
      truncated: true,
    });
    await expect(
      s.addFromStream({ filename: 'big.pdf', mimetype: 'application/pdf', stream }),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: 'file_too_large',
      message: '"big.pdf" is larger than 20 MB',
    });
    expect(await entries()).toEqual([]);
  });

  it('rejects the 11th file before reading it', async () => {
    const s = stager();
    for (let i = 0; i < MAX_MESSAGE_FILES; i++) await add(s, `f${i}.txt`, 'x');
    const stream = new PassThrough();
    await expect(
      s.addFromStream({ filename: 'eleven.txt', mimetype: 'text/plain', stream }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'too_many_files',
      message: 'Too many files: at most 10 per message',
    });
    expect(stream.readableFlowing).toBeNull();
    expect((await entries()).length).toBe(MAX_MESSAGE_FILES);
  });

  it('rejects the type before reading the stream', async () => {
    const s = stager();
    const stream = new PassThrough();
    await expect(
      s.addFromStream({ filename: 'x.docx', mimetype: 'application/msword', stream }),
    ).rejects.toMatchObject({ code: 'unsupported_file_type' });
    expect(stream.readableFlowing).toBeNull();
    expect(await entries()).toEqual([]);
  });

  it('stops on abort and removes the partial file', async () => {
    const controller = new AbortController();
    const s = stager(controller.signal);
    const stream = new PassThrough();
    const pending = s.addFromStream({ filename: 'slow.txt', mimetype: 'text/plain', stream });
    stream.write('partial');
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await entries()).toEqual([]);
  });

  it('builds prompt files relative to the tree with POSIX separators', async () => {
    const s = stager();
    await add(s, 'shot.png', pngBytes());
    await add(s, 'b.fb2', fb2Book());
    const treeDir = path.join(dir, 'tree');
    expect(s.promptFiles(treeDir)).toEqual([
      { path: '.tmp-answer-x/files/shot.png', name: 'shot.png', kind: 'image', size: 70 },
      {
        path: '.tmp-answer-x/files/b.fb2.md',
        name: 'b.fb2',
        kind: 'text',
        size: Buffer.byteLength(fb2Book()),
        bookOf: 'b.fb2',
      },
    ]);
  });
});

describe('listUserFiles', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await makeTempDir());
  });
  afterEach(() => cleanup());

  it('returns [] for a missing folder', async () => {
    expect(await listUserFiles(dir)).toEqual([]);
  });

  it('folds companions, skips parts and bad names, sorts by name', async () => {
    const files = path.join(dir, 'files');
    await mkdir(files);
    await mkdir(path.join(files, 'sub-dir'));
    for (const [name, content] of [
      ['z.md', 'zz'],
      ['book.epub', 'bin'],
      ['book.epub.md', 'text'],
      ['B.png', 'png'],
      ['.part-123', 'partial'],
      ['bad name.md', 'x'],
    ]) {
      await writeFile(path.join(files, name as string), content as string);
    }
    expect(await listUserFiles(dir)).toEqual([
      { name: 'B.png', size: 3, contentType: 'image/png', kind: 'image' },
      {
        name: 'book.epub',
        size: 3,
        contentType: 'application/epub+zip',
        kind: 'other',
        text: 'book.epub.md',
      },
      { name: 'z.md', size: 2, contentType: 'text/markdown; charset=utf-8', kind: 'text' },
    ]);
  });

  it('maps chain files to prompt paths', () => {
    expect(
      nodePromptFiles('a/b', [
        { name: 'x.png', size: 5, contentType: 'image/png', kind: 'image' },
        {
          name: 'k.epub',
          size: 9,
          contentType: 'application/epub+zip',
          kind: 'other',
          text: 'k.epub.md',
        },
      ]),
    ).toEqual([
      { path: 'a/b/files/x.png', name: 'x.png', kind: 'image', size: 5 },
      { path: 'a/b/files/k.epub.md', name: 'k.epub', kind: 'text', size: 9, bookOf: 'k.epub' },
    ]);
  });

  it('validates names in userFilePath', () => {
    expect(() => userFilePath('/trees/rust', 'a', '../x.md')).toThrow('Invalid file name');
    expect(() => userFilePath('/trees/rust', 'a', 'x..md')).toThrow('Invalid file name');
    expect(userFilePath('/trees/rust', 'a', 'x.md')).toBe(path.resolve('/trees/rust/a/files/x.md'));
  });
});
