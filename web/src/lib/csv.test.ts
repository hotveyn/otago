import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseCsv, toCsv } from './csv';

describe('parseCsv', () => {
  it('parses a simple table with a trailing newline', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n')).toEqual({
      header: ['a', 'b'],
      rows: [
        ['1', '2'],
        ['3', '4'],
      ],
      ragged: false,
    });
  });

  it('handles quotes, escaped quotes and embedded newlines', () => {
    const parsed = parseCsv('name,note\n"Smith, J","said ""hi"""\n"multi\nline",x');
    expect(parsed?.rows).toEqual([
      ['Smith, J', 'said "hi"'],
      ['multi\nline', 'x'],
    ]);
  });

  it('strips a BOM and handles CRLF', () => {
    expect(parseCsv('﻿a,b\r\n1,2\r\n')).toEqual({
      header: ['a', 'b'],
      rows: [['1', '2']],
      ragged: false,
    });
  });

  it('detects semicolons and tabs', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectDelimiter('a|b\n1|2')).toBe('|');
    expect(detectDelimiter('a,b\n"1;2",3')).toBe(',');
    expect(parseCsv('a;b\n1;2')?.rows).toEqual([['1', '2']]);
  });

  it('uses an explicit delimiter', () => {
    expect(parseCsv('a,b\tc\n1,2\t3', '\t')?.header).toEqual(['a,b', 'c']);
  });

  it('pads and truncates ragged rows', () => {
    const parsed = parseCsv('a,b,c\n1\n1,2,3,4\n');
    expect(parsed?.ragged).toBe(true);
    expect(parsed?.rows).toEqual([
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')?.rows).toEqual([['1', '2']]);
  });

  it('returns null for empty input', () => {
    expect(parseCsv('')).toBeNull();
    expect(parseCsv('  \n \n')).toBeNull();
    expect(parseCsv('﻿')).toBeNull();
  });
});

describe('toCsv', () => {
  it('quotes only when needed and uses CRLF', () => {
    expect(toCsv(['a', 'b'], [['x,y', 'say "hi"']])).toBe('a,b\r\n"x,y","say ""hi"""');
  });

  it('round-trips through parseCsv', () => {
    const header = ['name', 'value', 'note'];
    const rows = [
      ['a, b', '1', 'line\nbreak'],
      ['"quoted"', '', ' padded '],
      ['', '', ''],
    ];
    expect(parseCsv(toCsv(header, rows))).toEqual({ header, rows, ragged: false });
  });
});
