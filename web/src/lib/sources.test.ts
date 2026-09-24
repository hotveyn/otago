import { describe, expect, it } from 'vitest';
import { bookOfText, ebookExtensionOf, formatLabel, viewableFile } from './sources';

describe('e-book sources', () => {
  it('detects e-book extensions', () => {
    expect(ebookExtensionOf('War.FB2.zip')).toBe('.fb2.zip');
    expect(ebookExtensionOf('a.azw3')).toBe('.azw3');
    expect(ebookExtensionOf('a.zip')).toBeUndefined();
    expect(ebookExtensionOf('a.epub.md')).toBeUndefined();
  });

  it('maps books to their extracted text and back', () => {
    expect(viewableFile('rust.epub')).toBe('rust.epub.md');
    expect(viewableFile('notes.md')).toBe('notes.md');
    expect(bookOfText('rust.epub.md')).toBe('rust.epub');
    expect(bookOfText('notes.md')).toBeUndefined();
    expect(bookOfText('rust.epub')).toBeUndefined();
  });

  it('labels formats', () => {
    expect(formatLabel('war.fb2.zip')).toBe('fb2');
    expect(formatLabel('rust.epub.md')).toBe('epub');
    expect(formatLabel('paper.PDF')).toBe('pdf');
    expect(formatLabel('notes.md')).toBe('md');
  });
});
