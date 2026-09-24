import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidInputError } from '../src/errors.js';
import { extractEbookText } from '../src/storage/ebooks/index.js';
import { palmDocDecompress, trailingSize } from '../src/storage/ebooks/mobi.js';
import { makeApp, multipartBody } from './helpers.js';

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title id="t">The Rust Book</dc:title>
    <dc:creator>Steve Klabnik</dc:creator>
    <dc:creator>Carol Nichols</dc:creator>
  </metadata>
  <manifest>
    <item id="c2" href="text/ch%202.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const xhtml = (body: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ignored</title><style>p{}</style></head>
<body>${body}</body></html>`;

function epub(extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, string> = {
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': CONTAINER,
    'OEBPS/content.opf': OPF,
    'OEBPS/text/ch1.xhtml': xhtml(
      '<h1>Ownership</h1><p>Each value has an <em>owner</em>. See <a href="ch%202.xhtml#b">borrowing</a>.</p><img src="x.png" alt="x"/><ul><li>one</li><li>two</li></ul>',
    ),
    'OEBPS/text/ch 2.xhtml': xhtml(
      '<h2 id="b">Borrowing</h2><p>A <strong>reference</strong>, <a href="https://doc.rust-lang.org">docs</a>.</p>',
    ),
    ...extra,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

/** ASCII + Russian letters in windows-1251. */
function cp1251(text: string): Uint8Array {
  return Uint8Array.from(
    [...text].map((char) => {
      const code = char.charCodeAt(0);
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      if (code < 0x80) return code;
      throw new Error(`No cp1251 byte for ${char}`);
    }),
  );
}

const FB2 = `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description><title-info>
    <author><first-name>Лев</first-name><last-name>Толстой</last-name></author>
    <book-title>Война и мир</book-title>
  </title-info></description>
  <body>
    <title><p>Том первый</p></title>
    <epigraph><p>Эпиграф</p></epigraph>
    <section>
      <title><p>Часть</p><p>первая</p></title>
      <p>Текст <emphasis>курсив</emphasis> и <strong>жирный</strong><a l:href="#n1" type="note">1</a>.</p>
      <empty-line/>
      <poem><stanza><v>Строка раз</v><v>Строка два</v></stanza></poem>
      <image l:href="#img"/>
    </section>
  </body>
  <body name="notes"><section id="n1"><p>Сноска</p></section></body>
  <binary id="img" content-type="image/png">AAAA</binary>
</FictionBook>`;

/** Minimal PalmDB with a MOBI header; `text` is stored uncompressed. */
function mobi(options: {
  text: string;
  version?: number;
  encryption?: number;
  compression?: number;
  flows?: Array<[number, number]>;
}): Uint8Array {
  const text = Buffer.from(options.text);
  const title = Buffer.from('Mobi Title');
  const author = Buffer.from('Mobi Author');
  const headerLength = 0xe8;
  const exthStart = 16 + headerLength;
  const exthLength = 12 + 8 + author.length;
  const record0 = Buffer.alloc(exthStart + exthLength + title.length);
  record0.writeUInt16BE(options.compression ?? 1, 0);
  record0.writeUInt32BE(text.length, 4);
  record0.writeUInt16BE(1, 8);
  record0.writeUInt16BE(4096, 10);
  record0.writeUInt16BE(options.encryption ?? 0, 12);
  record0.write('MOBI', 16, 'ascii');
  record0.writeUInt32BE(headerLength, 20);
  record0.writeUInt32BE(65001, 28);
  record0.writeUInt32BE(options.version ?? 6, 36);
  record0.writeUInt32BE(exthStart + exthLength, 84);
  record0.writeUInt32BE(title.length, 88);
  record0.writeUInt32BE(0x40, 128);
  record0.writeUInt32BE(options.flows ? 2 : 0xffffffff, 0xc0);
  record0.writeUInt16BE(0, 0xf2);
  record0.write('EXTH', exthStart, 'ascii');
  record0.writeUInt32BE(exthLength, exthStart + 4);
  record0.writeUInt32BE(1, exthStart + 8);
  record0.writeUInt32BE(100, exthStart + 12);
  record0.writeUInt32BE(8 + author.length, exthStart + 16);
  author.copy(record0, exthStart + 20);
  title.copy(record0, exthStart + exthLength);

  const records: Buffer[] = [record0, text];
  if (options.flows) {
    const fdst = Buffer.alloc(12 + options.flows.length * 8);
    fdst.write('FDST', 0, 'ascii');
    fdst.writeUInt32BE(12, 4);
    fdst.writeUInt32BE(options.flows.length, 8);
    options.flows.forEach(([start, end], i) => {
      fdst.writeUInt32BE(start, 12 + i * 8);
      fdst.writeUInt32BE(end, 16 + i * 8);
    });
    records.push(fdst);
  }
  const pdb = Buffer.alloc(78 + records.length * 8 + 2);
  pdb.write('BOOKMOBI', 60, 'ascii');
  pdb.writeUInt16BE(records.length, 76);
  let offset = pdb.length;
  records.forEach((record, i) => {
    pdb.writeUInt32BE(offset, 78 + i * 8);
    offset += record.length;
  });
  return Buffer.concat([pdb, ...records]);
}

describe('e-book text extraction', () => {
  it('reads EPUB spine order, metadata and inline formatting', () => {
    const text = extractEbookText('rust.epub', epub());
    expect(text).toBe(
      `${[
        '<!-- Text extracted by Otago from sources/rust.epub -->',
        '# The Rust Book',
        '*Steve Klabnik, Carol Nichols*',
        '# Ownership\n\nEach value has an *owner*. See borrowing.\n\n-   one\n-   two',
        '## Borrowing\n\nA **reference**, [docs](https://doc.rust-lang.org).',
      ].join('\n\n')}\n`,
    );
  });

  it('rejects DRM-protected and broken EPUBs', () => {
    const encryption = `<encryption><EncryptedData><CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData></EncryptedData></encryption>`;
    expect(() =>
      extractEbookText('a.epub', epub({ 'META-INF/encryption.xml': encryption })),
    ).toThrow(/DRM-protected/);
    expect(() => extractEbookText('a.epub', strToU8('not a zip'))).toThrow(InvalidInputError);
    expect(() => extractEbookText('a.epub', zipSync({ a: strToU8('x') }))).toThrow(
      /container\.xml is missing/,
    );
  });

  it('reads FB2 in windows-1251 with sections, poems and notes', () => {
    const text = extractEbookText('war.fb2', cp1251(FB2));
    expect(text).toContain('# Война и мир\n\n*Лев Толстой*');
    expect(text).toContain('# Том первый\n\n> Эпиграф');
    expect(text).toContain('## Часть первая');
    expect(text).toContain('Текст *курсив* и **жирный**\\[1\\].');
    expect(text).toContain('> Строка раз  \n> Строка два');
    expect(text).toContain('# notes\n\nСноска');
    expect(text).not.toContain('AAAA');
  });

  it('reads FB2 inside a zip', () => {
    const archive = zipSync({ 'war.fb2': cp1251(FB2) });
    expect(extractEbookText('war.fb2.zip', archive)).toContain('## Часть первая');
    expect(() => extractEbookText('war.fb2.zip', zipSync({ 'a.txt': strToU8('x') }))).toThrow(
      /no \.fb2 file/,
    );
  });

  it('reads MOBI text with EXTH metadata', () => {
    const book = mobi({
      text: '<html><head><title>T</title></head><body><h2>Глава</h2><p>Привет, <b>мир</b></p></body></html>',
    });
    expect(extractEbookText('a.mobi', book)).toBe(
      '<!-- Text extracted by Otago from sources/a.mobi -->\n\n# Mobi Title\n\n*Mobi Author*\n\n## Глава\n\nПривет, **мир**\n',
    );
  });

  it('keeps only the HTML flow of an AZW3 (KF8) book', () => {
    const html = '<html><body><p>Main text</p></body></html>';
    const css = 'p { color: red }';
    const book = mobi({
      text: html + css,
      version: 8,
      flows: [
        [0, html.length],
        [html.length, html.length + css.length],
      ],
    });
    const text = extractEbookText('a.azw3', book);
    expect(text).toContain('Main text');
    expect(text).not.toContain('color');
  });

  it('rejects DRM, HUFF/CDIC and non-MOBI files', () => {
    expect(() => extractEbookText('a.mobi', mobi({ text: '<p>x</p>', encryption: 2 }))).toThrow(
      /DRM-protected/,
    );
    expect(() => extractEbookText('a.azw', mobi({ text: '<p>x</p>', compression: 17480 }))).toThrow(
      /HUFF\/CDIC/,
    );
    expect(() => extractEbookText('a.mobi', strToU8('x'.repeat(100)))).toThrow(/not a MOBI file/);
    expect(() => extractEbookText('a.mobi', mobi({ text: '<p> </p>' }))).toThrow(/no text found/);
  });

  it('decompresses PalmDoc literals, space pairs and back-references', () => {
    // "ab" + " c" (0xE3) + back-reference distance 4, length 5.
    const input = Uint8Array.from([0x02, 0x61, 0x62, 0xe3, 0x80, 0x22]);
    expect(Buffer.from(palmDocDecompress(input)).toString()).toBe('ab cab ca');
    expect(() => palmDocDecompress(Uint8Array.from([0x80, 0x22]))).toThrow(RangeError);
  });

  it('measures trailing record entries', () => {
    // Multibyte flag: low 2 bits of the last byte + 1.
    expect(trailingSize(Uint8Array.from([0x41, 0x42, 0x01]), 0b1)).toBe(2);
    // One trailing entry: backward varint 0x83 = size 3.
    expect(trailingSize(Uint8Array.from([0x41, 0x00, 0x00, 0x83]), 0b10)).toBe(3);
  });
});

describe('e-book sources API', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  beforeEach(async () => {
    ctx = await makeApp();
    await ctx.app.inject({ method: 'POST', url: '/api/trees', payload: { title: 'Rust' } });
  });
  afterEach(() => ctx.close());

  const upload = (filename: string, content: string | Uint8Array) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/trees/rust/sources',
      ...multipartBody('file', filename, content),
    });
  const sourcesDir = () => path.join(ctx.treesDir, 'rust', 'sources');

  it('stores the book with its extracted text and lists them as one source', async () => {
    const book = epub();
    const res = await upload('rust.epub', book);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: 'rust.epub', size: book.byteLength, text: 'rust.epub.md' });
    expect((await readdir(sourcesDir())).sort()).toEqual(['rust.epub', 'rust.epub.md']);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources' });
    expect(list.json()).toEqual({
      sources: [{ name: 'rust.epub', size: book.byteLength, text: 'rust.epub.md' }],
    });

    const original = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/sources/rust.epub',
    });
    expect(original.headers['content-type']).toBe('application/epub+zip');
    const text = await ctx.app.inject({
      method: 'GET',
      url: '/api/trees/rust/sources/rust.epub.md',
    });
    expect(text.headers['content-type']).toContain('text/markdown');
    expect(text.body).toContain('# Ownership');

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/trees/rust/sources/rust.epub',
    });
    expect(del.statusCode).toBe(204);
    expect(await readdir(sourcesDir())).toEqual([]);
  });

  it('rejects an unreadable book without saving anything', async () => {
    const res = await upload('broken.epub', 'not a zip');
    expect(res.statusCode).toBe(400);
    expect(res.json().error ?? res.body).toMatch(/Cannot read broken\.epub/);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/trees/rust/sources' });
    expect(list.json()).toEqual({ sources: [] });
  });

  it('accepts all e-book extensions and rejects other archives', async () => {
    expect((await upload('war.fb2', cp1251(FB2))).statusCode).toBe(201);
    expect((await upload('war.fb2.zip', zipSync({ 'w.fb2': cp1251(FB2) }))).statusCode).toBe(201);
    expect((await upload('a.mobi', mobi({ text: '<p>x</p>' }))).statusCode).toBe(201);
    expect((await upload('a.azw', mobi({ text: '<p>x</p>' }))).statusCode).toBe(201);
    expect((await upload('a.azw3', mobi({ text: '<p>x</p>' }))).statusCode).toBe(201);
    expect((await upload('a.zip', zipSync({ 'w.fb2': cp1251(FB2) }))).statusCode).toBe(400);
  });
});
