import { describe, expect, it } from 'vitest';
import { collapseWhitespace, firstLine, graphemes, truncateGraphemes } from './text';

const family = '👩‍👩‍👧';
const devanagari = 'हिन्दी';

describe('graphemes', () => {
  it('keeps ZWJ emoji and combining marks together', () => {
    expect(graphemes(`a${family}b`)).toEqual(['a', family, 'b']);
    expect(graphemes(devanagari).join('')).toBe(devanagari);
    expect(graphemes(devanagari).length).toBeLessThan(devanagari.length);
  });
});

describe('truncateGraphemes', () => {
  it('returns the text unchanged when it fits', () => {
    const text = 'short';
    expect(truncateGraphemes(text, 5)).toBe(text);
    expect(truncateGraphemes(`${family}${family}`, 2)).toBe(`${family}${family}`);
  });

  it('never cuts inside a grapheme', () => {
    expect(truncateGraphemes(`${family}${family}${family}`, 2)).toBe(`${family}${family}…`);
    // `ि` is a combining vowel sign: it stays with its consonant.
    expect(truncateGraphemes(devanagari, 1, '')).toBe('हि');
  });

  it('drops trailing whitespace before the ellipsis', () => {
    expect(truncateGraphemes('ab cd', 3)).toBe('ab…');
  });

  it('does not double an ellipsis that is already at the cut', () => {
    expect(truncateGraphemes('abc…def', 4)).toBe('abc…');
  });
});

describe('firstLine / collapseWhitespace', () => {
  it('finds the first non-empty trimmed line', () => {
    expect(firstLine('\n  \r\n  Привет мир  \nsecond')).toBe('Привет мир');
    expect(firstLine('   ')).toBe('');
  });

  it('collapses whitespace runs', () => {
    expect(collapseWhitespace('  a \t b\n\nc ')).toBe('a b c');
  });
});
