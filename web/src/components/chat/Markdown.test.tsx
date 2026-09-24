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
    expect(two).toContain('Export CSV');
    expect(two).toContain('aria-sort="none"');
    expect(two).toContain('<code>x</code>');
    const one = render('| a |\n|---|\n| 1 |');
    expect(one).not.toContain('Export CSV');
    expect(one).toContain('table-wrap');
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
