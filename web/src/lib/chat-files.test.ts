import { describe, expect, it } from 'vitest';
import {
  CHAT_FILE_ACCEPT,
  type ComposerFile,
  canSend,
  chatFileExtensionOf,
  isChatImage,
  MAX_MESSAGE_FILE_BYTES,
  normalizePastedFile,
  pastedFilesToAdd,
  restoreFiles,
  toComposerFiles,
  validateChatFiles,
} from './chat-files';

const file = (name: string, size = 3, type = '', lastModified = 1) =>
  new File([new Uint8Array(size)], name, { type, lastModified });

/** A File that reports `size` without allocating it. */
const sized = (name: string, size: number) => {
  const f = file(name, 1);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

const transfer = (files: File[], text?: Record<string, string>) => ({
  files: files as unknown as FileList,
  types: [...(files.length ? ['Files'] : []), ...Object.keys(text ?? {})],
  getData: (format: string) => text?.[format] ?? '',
});

describe('chatFileExtensionOf', () => {
  it('matches the longest allowed suffix, case-insensitively', () => {
    expect(chatFileExtensionOf('book.FB2.ZIP')).toBe('.fb2.zip');
    expect(chatFileExtensionOf('A.PDF')).toBe('.pdf');
    expect(chatFileExtensionOf('x.azw3')).toBe('.azw3');
  });

  it('rejects plain zips, stemless and extensionless names', () => {
    expect(chatFileExtensionOf('a.zip')).toBeUndefined();
    expect(chatFileExtensionOf('.png')).toBeUndefined();
    expect(chatFileExtensionOf('noext')).toBeUndefined();
  });
});

describe('CHAT_FILE_ACCEPT', () => {
  it('uses .zip instead of the compound .fb2.zip', () => {
    const accept = CHAT_FILE_ACCEPT.split(',');
    expect(accept).toContain('.zip');
    expect(accept).not.toContain('.fb2.zip');
    expect(accept).toContain('.png');
  });
});

describe('isChatImage', () => {
  it('uses the extension, then the MIME type for nameless files', () => {
    expect(isChatImage(file('a.JPG'))).toBe(true);
    expect(isChatImage(file('a.pdf', 3, 'image/png'))).toBe(false);
    expect(isChatImage(file('', 3, 'image/png'))).toBe(true);
    expect(isChatImage(file('', 3, 'application/pdf'))).toBe(false);
  });
});

describe('validateChatFiles', () => {
  it('rejects unsupported types with the allowed list', () => {
    const { accepted, rejected } = validateChatFiles([], [file('notes.docx')]);
    expect(accepted).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.name).toBe('notes.docx');
    expect(rejected[0]?.reason).toContain('.fb2.zip, .md, .txt');
  });

  it('rejects plain zips', () => {
    expect(validateChatFiles([], [file('a.zip')]).rejected).toHaveLength(1);
  });

  it('rejects empty and oversize files', () => {
    const { accepted, rejected } = validateChatFiles(
      [],
      [file('empty.txt', 0), sized('big.pdf', MAX_MESSAGE_FILE_BYTES + 1)],
    );
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(['The file is empty', 'Larger than 20 MB']);
  });

  it('accepts a file of exactly the cap', () => {
    expect(validateChatFiles([], [sized('ok.pdf', MAX_MESSAGE_FILE_BYTES)]).accepted).toHaveLength(
      1,
    );
  });

  it('enforces the per-message count', () => {
    const current = toComposerFiles(Array.from({ length: 8 }, (_, i) => file(`c${i}.md`)));
    const incoming = Array.from({ length: 4 }, (_, i) => file(`n${i}.md`));
    const { accepted, rejected } = validateChatFiles(current, incoming);
    expect(accepted.map((f) => f.name)).toEqual(['n0.md', 'n1.md']);
    expect(rejected.map((r) => r.name)).toEqual(['n2.md', 'n3.md']);
    expect(rejected[0]?.reason).toBe('Only 10 files per message');
  });

  it('accepts a nameless image but not a nameless pdf', () => {
    expect(validateChatFiles([], [file('', 3, 'image/png')]).accepted).toHaveLength(1);
    const pdf = validateChatFiles([], [file('', 3, 'application/pdf')]);
    expect(pdf.accepted).toEqual([]);
    expect(pdf.rejected[0]?.name).toBe('Pasted file');
  });

  it('skips exact duplicates silently', () => {
    const current = toComposerFiles([file('a.md')]);
    const { accepted, rejected } = validateChatFiles(current, [
      file('a.md'),
      file('b.md'),
      file('b.md'),
      file('a.md', 3, '', 2),
    ]);
    expect(accepted.map((f) => `${f.name}:${f.lastModified}`)).toEqual(['b.md:1', 'a.md:2']);
    expect(rejected).toEqual([]);
  });
});

describe('normalizePastedFile', () => {
  it('keeps a file with an allowed extension', () => {
    const f = file('image.png', 3, 'image/png');
    expect(normalizePastedFile(f, 1)).toBe(f);
  });

  it('names a nameless image from its MIME type', () => {
    const named = normalizePastedFile(file('', 4, 'image/png', 7), 1);
    expect(named.name).toBe('pasted-image-1.png');
    expect(named.type).toBe('image/png');
    expect(named.size).toBe(4);
    expect(named.lastModified).toBe(7);
  });

  it('leaves other nameless files unchanged', () => {
    const f = file('', 3, 'text/plain');
    expect(normalizePastedFile(f, 1)).toBe(f);
  });
});

describe('pastedFilesToAdd', () => {
  it('returns nothing without files', () => {
    expect(pastedFilesToAdd(transfer([], { 'text/plain': 'hi' }))).toEqual({
      files: [],
      blockText: false,
    });
  });

  it('blocks the text paste for an image only', () => {
    const result = pastedFilesToAdd(transfer([file('', 3, 'image/png')]));
    expect(result.blockText).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(['pasted-image-1.png']);
  });

  it('blocks the text paste when the text is just the file name', () => {
    const result = pastedFilesToAdd(transfer([file('a.pdf')], { 'text/plain': 'a.pdf\n' }));
    expect(result.blockText).toBe(true);
  });

  it('keeps the text paste for an image with real text', () => {
    const result = pastedFilesToAdd(
      transfer([file('image.png', 3, 'image/png')], {
        'text/plain': 'Some paragraph',
        'text/html': '<p>Some paragraph</p>',
      }),
    );
    expect(result.blockText).toBe(false);
    expect(result.files).toHaveLength(1);
  });
});

describe('canSend', () => {
  it('needs text or files and no stream', () => {
    expect(canSend('  ', [], false)).toBe(false);
    expect(canSend('q', [], false)).toBe(true);
    expect(canSend('', [1], false)).toBe(true);
    expect(canSend('q', [1], true)).toBe(false);
  });
});

describe('restoreFiles', () => {
  const snapshot: ComposerFile[] = toComposerFiles([file('a.md')]);

  it('restores the snapshot into an empty composer', () => {
    expect(restoreFiles([], snapshot)).toBe(snapshot);
  });

  it('keeps files added meanwhile', () => {
    const current = toComposerFiles([file('b.md')]);
    expect(restoreFiles(current, snapshot)).toBe(current);
  });
});

describe('toComposerFiles', () => {
  it('assigns unique ids', () => {
    const ids = [
      ...toComposerFiles([file('a.md'), file('b.md')]),
      ...toComposerFiles([file('c.md')]),
    ].map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
  });
});
