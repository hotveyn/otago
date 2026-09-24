import { describe, expect, it } from 'vitest';
import { compareCells, filterRows, parseNumeric, sortRows } from './table';

describe('parseNumeric', () => {
  it('reads plain, grouped, percent and signed numbers', () => {
    expect(parseNumeric('12')).toBe(12);
    expect(parseNumeric('-3')).toBe(-3);
    expect(parseNumeric('1,234.5')).toBe(1234.5);
    expect(parseNumeric('12%')).toBe(12);
    expect(parseNumeric('.5')).toBe(0.5);
    expect(parseNumeric('1e3')).toBe(1000);
  });

  it('rejects non-numbers', () => {
    expect(parseNumeric('')).toBeNull();
    expect(parseNumeric('abc')).toBeNull();
    expect(parseNumeric('1,2')).toBeNull();
    expect(parseNumeric('v2')).toBeNull();
  });
});

describe('compareCells', () => {
  it('compares numbers numerically', () => {
    expect(compareCells('9', '10')).toBeLessThan(0);
    expect(compareCells('1,000', '999')).toBeGreaterThan(0);
  });

  it('uses a numeric-aware collator for text', () => {
    expect(compareCells('item2', 'item10')).toBeLessThan(0);
    expect(compareCells('apple', 'Banana')).toBeLessThan(0);
    expect(compareCells('a', 'A')).toBe(0);
  });

  it('puts empty cells last', () => {
    expect(compareCells('', 'a')).toBeGreaterThan(0);
    expect(compareCells('a', ' ')).toBeLessThan(0);
  });
});

describe('sortRows', () => {
  const rows = [
    ['b', '10'],
    ['a', '9'],
    ['c', ''],
    ['a', '1,000'],
  ];

  it('sorts ascending and descending, empties last', () => {
    expect(sortRows(rows, 1, 'asc')).toEqual([1, 0, 3, 2]);
    expect(sortRows(rows, 1, 'desc')).toEqual([3, 0, 1, 2]);
  });

  it('is stable', () => {
    expect(sortRows(rows, 0, 'asc')).toEqual([1, 3, 0, 2]);
    expect(sortRows(rows, 0, 'desc')).toEqual([2, 0, 1, 3]);
  });
});

describe('filterRows', () => {
  const rows = [
    ['Rust', 'fast'],
    ['Go', 'Fast enough'],
    ['Python', 'slow'],
  ];

  it('matches case-insensitive substrings in any cell', () => {
    expect(filterRows(rows, 'FAST')).toEqual([0, 1]);
    expect(filterRows(rows, 'py')).toEqual([2]);
  });

  it('ANDs whitespace-separated terms', () => {
    expect(filterRows(rows, 'fast go')).toEqual([1]);
    expect(filterRows(rows, 'fast python')).toEqual([]);
  });

  it('returns everything for an empty query', () => {
    expect(filterRows(rows, '   ')).toEqual([0, 1, 2]);
  });
});
