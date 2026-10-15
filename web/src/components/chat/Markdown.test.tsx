import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AttachmentScopeValue } from '../../lib/attachments';
import { AttachmentScope } from './attachment-scope';
import { Markdown } from './Markdown';

const committed: AttachmentScopeValue = {
  treeId: 't',
  nodeId: 'n',
  attachments: [
    { name: 'layout.svg', size: 100, contentType: 'image/svg+xml', kind: 'svg' },
    { name: 'data.bin', size: 5, contentType: 'application/octet-stream', kind: 'other' },
  ],
  streaming: null,
};

function render(text: string, scope: AttachmentScopeValue | null = committed, streaming = false) {
  return renderToStaticMarkup(
    <AttachmentScope.Provider value={scope}>
      <Markdown text={text} streaming={streaming} />
    </AttachmentScope.Provider>,
  );
}

describe('Markdown (server render smoke test)', () => {
  it('adds controls to GFM tables with at least 2 rows only', () => {
    const two = render('| a | b |\n|---|---|\n| 1 | `x` |\n| 2 | y |');
    expect(two).toContain('aria-sort="none"');
    expect(two).toContain('<code>x</code>');
    const one = render('| a |\n|---|\n| 1 |');
    expect(one).not.toContain('aria-sort');
    expect(one).toContain('table-wrap');
  });

  it('shows the filter / export bar only on tables with 5+ columns or 20+ rows', () => {
    const small = render('| a | b |\n|---|---|\n| 1 | x |\n| 2 | y |');
    expect(small).not.toContain('Export CSV');
    expect(small).toContain('aria-sort="none"');
    const wide = render(
      '| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n| 6 | 7 | 8 | 9 | 0 |',
    );
    expect(wide).toContain('Export CSV');
    const body = Array.from({ length: 20 }, (_, i) => `| ${i} |`).join('\n');
    const long = render(`| a |\n|---|\n${body}`);
    expect(long).toContain('Export CSV');
  });

  it('renders closed csv fences as tables and unclosed streaming ones as source', () => {
    expect(render('```csv\nname,value\nx,1\n```')).toContain('<td>x</td>');
    const streaming = render('```csv\nname,value\nx,1', committed, true);
    expect(streaming).toContain('Table renders when complete');
    expect(streaming).not.toContain('<td>');
  });

  it('shows mermaid source while streaming and a placeholder before rendering', () => {
    expect(render('```mermaid\ngraph TD\nA-->B', committed, true)).toContain(
      'Diagram renders when complete',
    );
    expect(render('```mermaid\ngraph TD\nA-->B\n```')).toContain('Rendering diagram');
  });

  it('resolves attachment images and links against the scope', () => {
    const html = render(
      '![Layout](attachments/layout.svg) [bin](attachments/data.bin) ![x](attachments/typo.png)',
    );
    expect(html).toContain('src="/api/trees/t/attachments?node=n&amp;name=layout.svg"');
    expect(html).toContain(
      'href="/api/trees/t/attachments?node=n&amp;name=data.bin&amp;download=1"',
    );
    expect(html).toContain('Attachment not found: typo.png');
  });

  it('shows pending chips while streaming', () => {
    const html = render(
      '![x](attachments/wip.png)',
      { treeId: 't', nodeId: null, attachments: [], streaming: [] },
      true,
    );
    expect(html).toContain('saving…');
  });

  it('renders user questions as Markdown with plain', () => {
    const question = (text: string) => renderToStaticMarkup(<Markdown text={text} plain />);
    const quoted = question('> quoted\n\nask');
    expect(quoted).toContain('<blockquote>');
    expect(quoted).toMatch(/<\/blockquote>\s*<p>ask<\/p>/);
    expect(question('line one\nline two')).toContain('<p>line one\nline two</p>');
    const footnote = question('See [^1].\n\n[^1]: sources/notes.md:1');
    expect(footnote).not.toContain('Sources');
    expect(footnote).not.toContain('citations');
  });
});

const streamingScope: AttachmentScopeValue = {
  treeId: 't',
  nodeId: null,
  attachments: [],
  streaming: [],
};

describe('Markdown citations', () => {
  it('opens PDF sources in a new tab at the page, with the comment', () => {
    const html = render('Claim [^1].\n\n[^1]: sources/book.pdf:5-12 (contents)');
    expect(html).toContain(
      '<a class="cite-row" href="/api/trees/t/sources/book.pdf#page=5" target="_blank" rel="noopener noreferrer">',
    );
    expect(html).toContain('<span class="file-badge">pdf</span>');
    expect(html).toContain('pages 5–12');
    expect(html).toContain('title="contents">contents</span>');
    expect(html).toContain('cite-comment');
    expect(html).toMatch(
      /<a class="cite-chip cite-source" href="\/api\/trees\/t\/sources\/book\.pdf#page=5" target="_blank" rel="noopener noreferrer" title="book\.pdf · pages 5–12 — contents">1<\/a>/,
    );
  });

  it('opens text sources in the viewer', () => {
    const html = render('Claim [^1].\n\n[^1]: sources/notes.md:120-134');
    expect(html).toContain('<button type="button" class="cite-row">');
    expect(html).toContain('lines 120–134');
    expect(html).not.toContain('href=');
    expect(html).toContain('<button type="button" class="cite-chip cite-source"');
  });

  it('resolves user files of the own node once saved', () => {
    const html = render('A [^1] b [^2].\n\n[^1]: files/report.pdf:3\n[^2]: files/draft.md:10-12');
    expect(html).toContain('href="/api/trees/t/files?node=n&amp;name=report.pdf#page=3"');
    expect(html).toContain('files/report.pdf');
    expect(html).toContain('page 3');
    expect(html).toContain('<button type="button" class="cite-row">');
    expect(html).toContain('lines 10–12');
  });

  it('shows other nodes as an id path', () => {
    const html = render('A [^1].\n\n[^1]: ownership/intro/files/report.pdf:3');
    expect(html).toContain(
      'href="/api/trees/t/files?node=ownership%2Fintro&amp;name=report.pdf#page=3"',
    );
    expect(html).toContain('<bdi>ownership</bdi>');
    expect(html).toContain('<bdi>intro</bdi>');
  });

  it('keeps own-node file refs inert while the answer streams', () => {
    const html = render(
      'A [^1] b [^2].\n\n[^1]: files/report.pdf:3\n[^2]: sources/a.pdf:1',
      streamingScope,
      true,
    );
    expect(html).not.toContain('name=report.pdf');
    expect(html).toContain(
      '<span class="cite-row cite-text" title="Opens when the answer is saved">',
    );
    expect(html).toContain(
      '<button type="button" class="cite-chip cite-file" title="Opens when the answer is saved" disabled="">',
    );
    expect(html).toContain('href="/api/trees/t/sources/a.pdf#page=1"');
  });

  it('leaves text with a ref in the middle as text', () => {
    const html = render('A [^1].\n\n[^1]: see sources/a.md:1-2');
    expect(html).toContain('<span class="cite-row cite-text">see sources/a.md:1-2</span>');
    expect(html).not.toContain('cite-file');
  });

  it('routes inline file links through the same actions', () => {
    const pdf = render('See [x](sources/a.pdf:3).');
    expect(pdf).toContain(
      '<a class="source-link external" href="/api/trees/t/sources/a.pdf#page=3" target="_blank" rel="noopener noreferrer">x</a>',
    );
    const md = render('See [x](sources/a.md:3).');
    expect(md).toContain('<button type="button" class="source-link">x</button>');
    const unicode = render('См. sources/Клеппман (2).md:4.');
    expect(unicode).toContain(
      '<button type="button" class="source-link">sources/Клеппман (2).md:4</button>',
    );
  });
});
