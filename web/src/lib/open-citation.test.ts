import { describe, expect, it } from 'vitest';
import type { CitationTarget } from './citations';
import { openActionFor, PDF_PAGE_FRAGMENT } from './open-citation';

const saved = { treeId: 't', nodeId: 'n' };
const streaming = { treeId: 't', nodeId: null };

describe('openActionFor', () => {
  it('opens PDF sources in a new tab at the cited page', () => {
    expect(openActionFor({ kind: 'source', file: 'a.pdf', start: 5, end: 12 }, saved)).toEqual({
      kind: 'new-tab',
      url: '/api/trees/t/sources/a.pdf#page=5',
    });
    expect(openActionFor({ kind: 'source', file: 'a.pdf' }, saved)).toEqual({
      kind: 'new-tab',
      url: '/api/trees/t/sources/a.pdf',
    });
    expect(openActionFor({ kind: 'source', file: 'Клеппман (2).PDF', start: 2 }, saved)).toEqual({
      kind: 'new-tab',
      url: `/api/trees/t/sources/${encodeURIComponent('Клеппман (2).PDF')}#page=2`,
    });
    expect(PDF_PAGE_FRAGMENT(7)).toBe('#page=7');
  });

  it('opens text sources in the viewer, e-books through their companion', () => {
    expect(openActionFor({ kind: 'source', file: 'a.md', start: 1, end: 4 }, saved)).toEqual({
      kind: 'viewer',
      where: 'source',
      name: 'a.md',
      start: 1,
      end: 4,
    });
    expect(openActionFor({ kind: 'source', file: 'book.epub', start: 12, end: 20 }, saved)).toEqual(
      {
        kind: 'viewer',
        where: 'source',
        name: 'book.epub.md',
        start: 12,
        end: 20,
      },
    );
    // No answer scope (plain viewers): text sources still open, PDFs cannot be addressed.
    expect(openActionFor({ kind: 'source', file: 'a.txt', start: 3 }, null)).toMatchObject({
      kind: 'viewer',
      where: 'source',
    });
    expect(openActionFor({ kind: 'source', file: 'a.pdf' }, null)).toEqual({ kind: 'none' });
  });

  it('resolves user files against the own or an explicit node', () => {
    expect(openActionFor({ kind: 'file', name: 'report.pdf', start: 3, end: 3 }, saved)).toEqual({
      kind: 'new-tab',
      url: '/api/trees/t/files?node=n&name=report.pdf#page=3',
    });
    expect(
      openActionFor({ kind: 'file', node: 'ownership/intro', name: 'report.pdf', start: 3 }, saved),
    ).toEqual({
      kind: 'new-tab',
      url: '/api/trees/t/files?node=ownership%2Fintro&name=report.pdf#page=3',
    });
    expect(openActionFor({ kind: 'file', name: 'report.pdf', start: 3 }, streaming)).toEqual({
      kind: 'none',
    });
    expect(
      openActionFor({ kind: 'file', node: 'other', name: 'report.pdf', start: 3 }, streaming),
    ).toMatchObject({ kind: 'new-tab' });
    expect(openActionFor({ kind: 'file', name: 'draft.md', start: 10, end: 12 }, saved)).toEqual({
      kind: 'viewer',
      where: 'file',
      node: 'n',
      name: 'draft.md',
      start: 10,
      end: 12,
    });
    expect(openActionFor({ kind: 'file', name: 'photo.png', start: 2 }, saved)).toEqual({
      kind: 'new-tab',
      url: '/api/trees/t/files?node=n&name=photo.png',
    });
    expect(openActionFor({ kind: 'file', name: 'draft.md' }, null)).toEqual({ kind: 'none' });
  });

  it('normalizes ids and names to NFC once more', () => {
    const nfd = 'café';
    expect(openActionFor({ kind: 'source', file: `${nfd}.pdf` }, saved)).toEqual({
      kind: 'new-tab',
      url: `/api/trees/t/sources/${encodeURIComponent('café.pdf')}`,
    });
    expect(openActionFor({ kind: 'file', node: nfd, name: 'a.md' }, saved)).toMatchObject({
      node: 'café',
    });
  });

  it('opens urls in a new tab and does nothing for text', () => {
    const url: CitationTarget = { kind: 'url', url: 'https://x.dev/a' };
    expect(openActionFor(url, saved)).toEqual({ kind: 'new-tab', url: 'https://x.dev/a' });
    expect(openActionFor({ kind: 'text', text: 'General knowledge' }, saved)).toEqual({
      kind: 'none',
    });
  });
});
