import { describe, expect, it } from 'vitest';
import { describeTarget, extractCitations, parseCitationTarget, parseSourceRef } from './citations';

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
    expect(parseSourceRef('sources/a%20b.md:1-2')?.file).toBe('a b.md');
    expect(parseSourceRef('sources/paper.pdf')).toEqual({
      kind: 'source',
      file: 'paper.pdf',
      start: undefined,
      end: undefined,
    });
    expect(parseSourceRef('https://x.dev')).toBeNull();
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
    expect(parseCitationTarget('`sources/a.md:1-3`')).toMatchObject({
      kind: 'source',
      file: 'a.md',
    });
    expect(parseCitationTarget('General knowledge')).toEqual({
      kind: 'text',
      text: 'General knowledge',
    });
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
  });

  it('appends unreferenced definitions', () => {
    const { citations } = extractCitations('Text.\n\n[^x]: https://a.dev');
    expect(citations).toMatchObject([{ key: 'x', number: 1 }]);
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
  });
});

describe('pathOf', () => {
  it('drops scheme, host and trailing slash', async () => {
    const { pathOf } = await import('./citations');
    expect(pathOf('https://doc.rust-lang.org/book/ch04.html')).toBe('/book/ch04.html');
    expect(pathOf('https://example.com/')).toBe('example.com');
  });
});
