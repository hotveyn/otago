import { describe, expect, it } from 'vitest';
import { appendQuote, isQuotable, toBlockquote } from './quote';

describe('toBlockquote', () => {
  it('prefixes single and multiple lines', () => {
    expect(toBlockquote('hello')).toBe('> hello');
    expect(toBlockquote('a\nb')).toBe('> a\n> b');
  });

  it('turns empty lines into > and collapses runs of them', () => {
    expect(toBlockquote('a\n\nb')).toBe('> a\n>\n> b');
    expect(toBlockquote('a\n\n\n\nb')).toBe('> a\n>\n> b');
  });

  it('normalizes CRLF, CR and NBSP and trims trailing spaces', () => {
    expect(toBlockquote('a b  \r\nc\rd\t')).toBe('> a b\n> c\n> d');
  });

  it('strips leading and trailing blank lines but keeps indentation', () => {
    expect(toBlockquote('\n\n a \n\n')).toBe('>  a');
    expect(toBlockquote('fn x() {\n  y();\n}')).toBe('> fn x() {\n>   y();\n> }');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(toBlockquote('')).toBe('');
    expect(toBlockquote(' \n\t\n ')).toBe('');
  });
});

describe('appendQuote', () => {
  it('replaces an empty or whitespace-only draft', () => {
    expect(appendQuote('', 'x')).toBe('> x\n\n');
    expect(appendQuote('   \n', 'x')).toBe('> x\n\n');
  });

  it('leaves exactly one blank line before the quote', () => {
    expect(appendQuote('Q', 'x')).toBe('Q\n\n> x\n\n');
    expect(appendQuote('Q\n', 'x')).toBe('Q\n\n> x\n\n');
    expect(appendQuote('Q\n\n', 'x')).toBe('Q\n\n> x\n\n');
  });

  it('keeps two quotes in a row as separate blockquotes', () => {
    expect(appendQuote(appendQuote('', 'a'), 'b')).toBe('> a\n\n> b\n\n');
  });

  it('leaves the draft unchanged for whitespace-only text', () => {
    expect(appendQuote('Q', '   ')).toBe('Q');
  });
});

describe('isQuotable', () => {
  it('requires non-whitespace text', () => {
    expect(isQuotable('')).toBe(false);
    expect(isQuotable(' \n\t')).toBe(false);
    expect(isQuotable(' a ')).toBe(true);
  });
});
