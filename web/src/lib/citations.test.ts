import { describe, expect, it } from 'vitest';
import {
  type CitationTarget,
  describeRange,
  describeTarget,
  extractCitations,
  extractComment,
  parseCitationTarget,
  parseRef,
  parseSourceRef,
  parseWholeRef,
  unitOf,
  viewableName,
} from './citations';

describe('parseSourceRef', () => {
  it('parses file and line ranges', () => {
    expect(parseSourceRef('sources/the-book-ch4.md:120-134')).toEqual({
      kind: 'source',
      file: 'the-book-ch4.md',
      start: 120,
      end: 134,
    });
    expect(parseSourceRef('./sources/a.txt:5')).toEqual({
      kind: 'source',
      file: 'a.txt',
      start: 5,
      end: 5,
    });
    // Percent-decoding happens in the link forms / the Anchor, before parsing.
    expect(parseSourceRef(decodeURIComponent('sources/a%20b.md:1-2'))?.file).toBe('a b.md');
    expect(parseSourceRef('sources/a%20b.md:1-2')).toBeNull();
    expect(parseSourceRef('sources/Высоконагруженные приложения (Клеппман).pdf.md:12-20')).toEqual({
      kind: 'source',
      file: 'Высоконагруженные приложения (Клеппман).pdf.md',
      start: 12,
      end: 20,
    });
    expect(parseSourceRef('sources/paper.pdf')).toEqual({
      kind: 'source',
      file: 'paper.pdf',
      start: undefined,
      end: undefined,
    });
    expect(parseSourceRef('https://x.dev')).toBeNull();
    expect(parseSourceRef('sources/a.md:1 note')).toBeNull();
    expect(parseSourceRef('files/a.md:1')).toBeNull();
  });
});

describe('parseRef / parseWholeRef', () => {
  it('returns the ref and the remainder', () => {
    expect(parseRef('sources/a.pdf:1-4 (cover)')).toEqual({
      target: { kind: 'source', file: 'a.pdf', start: 1, end: 4 },
      rest: ' (cover)',
    });
    expect(parseRef('files/a.md:2 x')).toEqual({
      target: { kind: 'file', node: undefined, name: 'a.md', start: 2, end: 2 },
      rest: ' x',
    });
    expect(parseRef('sources/a.md:0-3')).toBeNull();
    expect(parseRef('nope')).toBeNull();
  });

  it('accepts only a whole ref', () => {
    expect(parseWholeRef(' ownership/intro/files/report.pdf:3 ')).toEqual({
      kind: 'file',
      node: 'ownership/intro',
      name: 'report.pdf',
      start: 3,
      end: 3,
    });
    expect(parseWholeRef('sources/a.md:1 note')).toBeNull();
  });

  it('normalizes names and node ids to NFC', () => {
    const nfd = 'café';
    expect(parseRef(`sources/${nfd}.md:1`)?.target).toMatchObject({ file: 'café.md' });
    expect(parseRef(`${nfd}/files/a.md:1`)?.target).toMatchObject({ node: 'café' });
  });
});

/** Verbatim copy of the contract CONFORMANCE table (contracts/citations.ts §7). */
const CONFORMANCE: ReadonlyArray<{ in: string; out: Partial<CitationTarget> & { kind: string } }> =
  [
    // F1: plain refs (existing behaviour kept)
    {
      in: 'sources/the-book-ch4.md:120-134',
      out: { kind: 'source', file: 'the-book-ch4.md', start: 120, end: 134 },
    },
    { in: 'sources/notes.md:7', out: { kind: 'source', file: 'notes.md', start: 7, end: 7 } },
    {
      in: './sources/notes.txt:3 – 5',
      out: { kind: 'source', file: 'notes.txt', start: 3, end: 5 },
    },
    {
      in: 'sources/paper.pdf',
      out: { kind: 'source', file: 'paper.pdf', start: undefined, end: undefined },
    },
    { in: 'sources/paper.pdf:5-12', out: { kind: 'source', file: 'paper.pdf', start: 5, end: 12 } },
    // Unicode names with spaces/parentheses (needs the uncommitted source-names change)
    {
      in: 'sources/Высоконагруженные приложения (Клеппман).pdf:1-4',
      out: {
        kind: 'source',
        file: 'Высоконагруженные приложения (Клеппман).pdf',
        start: 1,
        end: 4,
      },
    },
    {
      in: 'sources/my notes v2.md intro',
      out: { kind: 'source', file: 'my notes v2.md', comment: 'intro' },
    },
    { in: 'sources/a.md.txt:3', out: { kind: 'source', file: 'a.md.txt', start: 3, end: 3 } },
    // F2: ref + comment (the screenshot case)
    {
      in: 'sources/desiging-data-intesive-applications.pdf:1-4 (страницы PDF: обложка и выходные данные)',
      out: {
        kind: 'source',
        file: 'desiging-data-intesive-applications.pdf',
        start: 1,
        end: 4,
        comment: 'страницы PDF: обложка и выходные данные',
      },
    },
    {
      in: 'sources/a.pdf:1-4 — cover',
      out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' },
    },
    {
      in: 'sources/a.pdf:1-4, cover.',
      out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' },
    },
    // F3/F4: backticks
    { in: '`sources/a.pdf:1-4`', out: { kind: 'source', file: 'a.pdf', start: 1, end: 4 } },
    {
      in: '`sources/a.pdf:1-4` — cover',
      out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' },
    },
    // F5: angle brackets
    { in: '<sources/a.md:2-3>', out: { kind: 'source', file: 'a.md', start: 2, end: 3 } },
    // F6/F7: Markdown link (percent-encoded destination), label ignored for files
    {
      in: '[Kleppmann](sources/a%20b.pdf:1-4)',
      out: { kind: 'source', file: 'a b.pdf', start: 1, end: 4 },
    },
    {
      in: '[label](sources/a.pdf:1-4) cover',
      out: { kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' },
    },
    // E-books: binary name tolerated, companion preferred; both are `line`
    {
      in: 'sources/book.epub:12-20',
      out: { kind: 'source', file: 'book.epub', start: 12, end: 20 },
    },
    {
      in: 'sources/book.epub.md:12-20',
      out: { kind: 'source', file: 'book.epub.md', start: 12, end: 20 },
    },
    // User files
    {
      in: 'files/report.pdf:3',
      out: { kind: 'file', node: undefined, name: 'report.pdf', start: 3, end: 3 },
    },
    {
      in: 'files/draft.md:10-12',
      out: { kind: 'file', node: undefined, name: 'draft.md', start: 10, end: 12 },
    },
    {
      in: 'ownership/intro/files/report.pdf:3',
      out: { kind: 'file', node: 'ownership/intro', name: 'report.pdf', start: 3, end: 3 },
    },
    {
      in: 'правила-заимствования/files/notes.txt:4-5 (см. таблицу)',
      out: {
        kind: 'file',
        node: 'правила-заимствования',
        name: 'notes.txt',
        start: 4,
        end: 5,
        comment: 'см. таблицу',
      },
    },
    { in: 'files/photo.png', out: { kind: 'file', node: undefined, name: 'photo.png' } },
    { in: 'files/report.pdf.', out: { kind: 'file', node: undefined, name: 'report.pdf' } },
    // URLs (unchanged)
    {
      in: 'https://doc.rust-lang.org/book/ch04-02.html',
      out: { kind: 'url', url: 'https://doc.rust-lang.org/book/ch04-02.html' },
    },
    {
      in: '[The Book](https://doc.rust-lang.org/book/)',
      out: { kind: 'url', url: 'https://doc.rust-lang.org/book/', title: 'The Book' },
    },
    // Negative: ref not first → text
    { in: 'see sources/a.md:1-2', out: { kind: 'text' } },
    { in: 'Chapter 4 of sources/a.md', out: { kind: 'text' } },
    // A non-numeric "range" is a comment on a ref without a range (opens the PDF on page 1)
    {
      in: 'sources/a.pdf:p. 3',
      out: { kind: 'source', file: 'a.pdf', start: undefined, comment: 'p. 3' },
    },
    {
      in: 'sources/a.pdf:pages 3-5',
      out: { kind: 'source', file: 'a.pdf', start: undefined, comment: 'pages 3-5' },
    },
    // Negative: unknown extension, path tricks, other folders, zero → text
    { in: 'sources/notes', out: { kind: 'text' } },
    { in: 'sources/../tree.md:1', out: { kind: 'text' } },
    { in: 'files/../node.md:1', out: { kind: 'text' } },
    { in: 'attachments/chart.svg', out: { kind: 'text' } },
    { in: 'sources/a.md:0-3', out: { kind: 'text' } }, // start must be ≥ 1 (web: reject or clamp; reject = text)
  ];

describe('conformance (contract table)', () => {
  it('covers every contract row', () => {
    expect(CONFORMANCE).toHaveLength(35);
  });

  it.each(CONFORMANCE)('$in', ({ in: input, out }) => {
    const target = parseCitationTarget(input) as Record<string, unknown>;
    const defined: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out)) {
      if (value === undefined) expect(target[key]).toBeUndefined();
      else defined[key] = value;
    }
    expect(target).toMatchObject(defined);
    if (!('comment' in out)) expect(target.comment).toBeUndefined();
  });
});

describe('parseCitationTarget', () => {
  it('recognizes urls, markdown links and plain text', () => {
    expect(parseCitationTarget('https://doc.rust-lang.org/book/ch04.html')).toEqual({
      kind: 'url',
      url: 'https://doc.rust-lang.org/book/ch04.html',
      title: undefined,
    });
    expect(parseCitationTarget('[The Book](https://doc.rust-lang.org/book/)')).toEqual({
      kind: 'url',
      url: 'https://doc.rust-lang.org/book/',
      title: 'The Book',
    });
    expect(parseCitationTarget('Rust blog — https://blog.rust-lang.org/')).toMatchObject({
      kind: 'url',
      title: 'Rust blog',
    });
    expect(parseCitationTarget('<https://x.dev/a>')).toEqual({
      kind: 'url',
      url: 'https://x.dev/a',
      title: undefined,
    });
    expect(parseCitationTarget('`sources/a.md:1-3`')).toMatchObject({
      kind: 'source',
      file: 'a.md',
    });
    expect(parseCitationTarget('General knowledge')).toEqual({
      kind: 'text',
      text: 'General knowledge',
    });
    expect(parseCitationTarget('  General knowledge.  ')).toEqual({
      kind: 'text',
      text: 'General knowledge.',
    });
  });

  it('extracts comments without producing a second ref', () => {
    const cases: Array<[string, string | undefined]> = [
      ['(cover)', 'cover'],
      ['— cover', 'cover'],
      [', cover.', 'cover.'],
      [': see p. 3', 'see p. 3'],
      ['((nested))', '(nested)'],
      ['(a) and (b)', '(a) and (b)'],
      ['   ', undefined],
      ['', undefined],
      ['(', '('],
    ];
    for (const [rest, comment] of cases) expect(extractComment(rest)).toBe(comment);
    expect(parseCitationTarget('sources/a.pdf:1 vs sources/b.pdf:2')).toEqual({
      kind: 'source',
      file: 'a.pdf',
      start: 1,
      end: 1,
      comment: 'vs sources/b.pdf:2',
    });
    expect(parseCitationTarget('sources/a.pdf:1-2 ')).not.toHaveProperty('comment');
  });

  it('handles wrappers', () => {
    expect(parseCitationTarget('`sources/a.pdf:1-4 x`')).toEqual({
      kind: 'text',
      text: '`sources/a.pdf:1-4 x`',
    });
    expect(parseCitationTarget('<sources/a.md:2-3>')).toMatchObject({
      kind: 'source',
      file: 'a.md',
      start: 2,
      end: 3,
    });
    expect(parseCitationTarget('[label](files/a.md:1)')).toEqual({
      kind: 'file',
      node: undefined,
      name: 'a.md',
      start: 1,
      end: 1,
    });
    expect(parseCitationTarget('[Book](https://x.dev) note')).toEqual({
      kind: 'url',
      url: 'https://x.dev',
      title: 'Book',
      comment: 'note',
    });
    expect(parseCitationTarget('[x](sources/notes):1')).toMatchObject({ kind: 'text' });
  });

  it('normalizes ranges and extensions', () => {
    expect(parseCitationTarget('sources/a.md:9-3')).toMatchObject({ start: 9, end: 9 });
    expect(parseCitationTarget('sources/a.md:0')).toMatchObject({ kind: 'text' });
    expect(parseCitationTarget('sources/a.md:3 – 5')).toMatchObject({ start: 3, end: 5 });
    expect(parseCitationTarget('sources/a.PDF:3')).toMatchObject({
      kind: 'source',
      file: 'a.PDF',
      start: 3,
    });
    expect(parseCitationTarget('sources/a.pdf:3.')).toMatchObject({ start: 3, end: 3 });
    expect(parseCitationTarget('files/report.pdf:3;')).toMatchObject({ start: 3, end: 3 });
  });

  it('yields NFC file names', () => {
    const nfd = 'café';
    expect(parseCitationTarget(`sources/${nfd}.md:1`)).toMatchObject({ file: 'café.md' });
  });
});

describe('units and labels', () => {
  it('derives the unit from the name', () => {
    expect(unitOf('a.PDF')).toBe('page');
    expect(unitOf('book.epub')).toBe('line');
    expect(unitOf('book.epub.md')).toBe('line');
    expect(unitOf('notes.txt')).toBe('line');
    expect(unitOf('photo.png')).toBe('none');
    expect(viewableName('book.epub')).toBe('book.epub.md');
    expect(viewableName('a.md')).toBe('a.md');
  });

  it('describes ranges by unit', () => {
    expect(describeRange('a.pdf', 5, 12)).toBe('pages 5–12');
    expect(describeRange('a.pdf', 3, 3)).toBe('page 3');
    expect(describeRange('a.pdf', 3)).toBe('page 3');
    expect(describeRange('a.md', 1, 4)).toBe('lines 1–4');
    expect(describeRange('a.md', 7)).toBe('line 7');
    expect(describeRange('photo.png', 1)).toBeUndefined();
    expect(describeRange('a.md')).toBeUndefined();
  });
});

describe('extractCitations', () => {
  it('numbers footnotes by first reference and rewrites them to cite links', () => {
    const md = [
      'Borrowing [^b] lets you reference a value [^a]. Again [^b].',
      '',
      '[^a]: sources/the-book-ch4.md:120-134',
      '[^b]: https://doc.rust-lang.org/book/',
    ].join('\n');
    const { body, citations } = extractCitations(md);
    expect(body).toBe(
      'Borrowing [1](#cite-b) lets you reference a value [2](#cite-a). Again [1](#cite-b).',
    );
    expect(citations.map((c) => [c.key, c.number, c.target.kind])).toEqual([
      ['b', 1, 'url'],
      ['a', 2, 'source'],
    ]);
  });

  it('leaves code blocks and inline code untouched', () => {
    const md = [
      'Use `x[^1]` here [^1].',
      '',
      '```rust',
      'let a = v[^1];',
      '[^1]: not a definition',
      '```',
      '',
      '[^1]: sources/a.md:1-2',
    ].join('\n');
    const { body, citations } = extractCitations(md);
    expect(body).toContain('Use `x[^1]` here [1](#cite-1).');
    expect(body).toContain('let a = v[^1];\n[^1]: not a definition');
    expect(citations).toHaveLength(1);
  });

  it('links plain-text source references and keeps unknown refs', () => {
    const { body } = extractCitations('See sources/notes.md:4-9 and [^missing].');
    expect(body).toBe('See [sources/notes.md:4-9](sources/notes.md:4-9) and [^missing].');
    const ref = 'sources/Высоконагруженные приложения (Клеппман).pdf.md:12';
    const href = 'sources/Высоконагруженные%20приложения%20%28Клеппман%29.pdf.md:12';
    expect(extractCitations(`См. ${ref}.`).body).toBe(`См. [${ref}](${href}).`);
    expect(parseSourceRef(decodeURIComponent(href))?.file).toBe(
      'Высоконагруженные приложения (Клеппман).pdf.md',
    );
  });

  it('rewrites references followed by a colon and strips indented definitions', () => {
    const md = [
      'Вариант на JavaScript[^1]:',
      '',
      '```js',
      'f();',
      '```',
      '',
      'Again[^1]: done.',
      '',
      '  [^1]: sources/a.pdf:70',
    ].join('\n');
    const { body, citations } = extractCitations(md);
    expect(body).toBe(
      'Вариант на JavaScript[1](#cite-1):\n\n```js\nf();\n```\n\nAgain[1](#cite-1): done.',
    );
    expect(citations).toMatchObject([{ key: '1', number: 1, target: { kind: 'source' } }]);
  });

  it('appends unreferenced definitions', () => {
    const { citations } = extractCitations('Text.\n\n[^x]: https://a.dev');
    expect(citations).toMatchObject([{ key: 'x', number: 1 }]);
  });

  it('parses user-file footnotes with comments', () => {
    const { citations } = extractCitations('A [^1].\n\n[^1]: files/report.pdf:3 (table)');
    expect(citations[0]?.target).toEqual({
      kind: 'file',
      node: undefined,
      name: 'report.pdf',
      start: 3,
      end: 3,
      comment: 'table',
    });
  });
});

describe('describeTarget', () => {
  it('formats sources', () => {
    expect(describeTarget({ kind: 'source', file: 'a.md', start: 1, end: 4 })).toBe(
      'a.md · lines 1–4',
    );
    expect(describeTarget({ kind: 'source', file: 'a.md', start: 3, end: 3 })).toBe(
      'a.md · line 3',
    );
    expect(describeTarget({ kind: 'source', file: 'a.pdf' })).toBe('a.pdf');
    expect(
      describeTarget({ kind: 'source', file: 'a.pdf', start: 1, end: 4, comment: 'cover' }),
    ).toBe('a.pdf · pages 1–4 — cover');
  });

  it('formats user files, urls and text', () => {
    expect(
      describeTarget({ kind: 'file', node: 'ownership/intro', name: 'report.pdf', start: 3 }),
    ).toBe('ownership/intro/files/report.pdf · page 3');
    expect(describeTarget({ kind: 'file', name: 'photo.png', start: 2 })).toBe('files/photo.png');
    expect(describeTarget({ kind: 'url', url: 'https://x.dev', title: 'X' })).toBe('X');
    expect(describeTarget({ kind: 'url', url: 'https://x.dev' })).toBe('https://x.dev');
    expect(describeTarget({ kind: 'text', text: 'General' })).toBe('General');
  });
});

describe('pathOf', () => {
  it('drops scheme, host and trailing slash', async () => {
    const { pathOf } = await import('./citations');
    expect(pathOf('https://doc.rust-lang.org/book/ch04.html')).toBe('/book/ch04.html');
    expect(pathOf('https://example.com/')).toBe('example.com');
  });
});
