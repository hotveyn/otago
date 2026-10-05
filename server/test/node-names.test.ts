import { describe, expect, it } from 'vitest';
import {
  isNodeName,
  NODE_NAME_MAX_CODE_POINTS,
  NODE_NAME_MAX_UTF8_BYTES,
  NODE_NAME_RE,
  nameKey,
  toNodeName,
} from '../src/storage/index.js';
import {
  collapseWhitespace,
  firstLine,
  graphemes,
  truncateGraphemes,
  utf8Length,
} from '../src/text.js';

const codePoints = (s: string) => [...s].length;

describe('toNodeName', () => {
  it.each([
    ['Правила Заимствования', 'правила-заимствования'],
    ['Привет', 'привет'],
    ['Borrowing Rules', 'borrowing-rules'],
    ['Café crème', 'café-crème'],
    ['हिन्दी नाम', 'हिन्दी-नाम'],
    ['漢字 と かな', '漢字-と-かな'],
    ['ΟΔΟΣ', 'οδος'],
    ['İstanbul', 'i̇stanbul'],
    ['ﬁles and ＡＢＣ', 'files-and-abc'],
    ['x² + y²', 'x2-y2'],
    ['👩‍👩‍👧 !!!', 'node'],
    ['a‍b', 'a-b'],
    ['a‏b', 'a-b'],
    ['../../etc/passwd', 'etc-passwd'],
    ['  --leading--and--trailing--  ', 'leading-and-trailing'],
    ['́́accent', 'accent'],
    ['', 'node'],
  ])('%j → %j', (input, expected) => {
    expect(toNodeName(input)).toBe(expected);
  });

  it('decomposed input comes out NFC', () => {
    const name = toNodeName('Café');
    expect(name).toBe('café');
    expect(name).toBe(name.normalize('NFC'));
  });

  it('uses the fallback and maxWords options', () => {
    expect(toNodeName('???', { fallback: 'tree' })).toBe('tree');
    expect(toNodeName('one two three four five', { maxWords: 4 })).toBe('one-two-three-four');
    expect(toNodeName('один два три четыре пять', { maxWords: 2 })).toBe('один-два');
  });

  it('caps at 60 code points by dropping whole words first', () => {
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const name = toNodeName(words);
    expect(codePoints(name)).toBeLessThanOrEqual(NODE_NAME_MAX_CODE_POINTS);
    expect(words.replaceAll(' ', '-').startsWith(name)).toBe(true);
    expect(name.endsWith('-')).toBe(false);
  });

  it('caps at 100 UTF-8 bytes (Cyrillic: 2 bytes per letter)', () => {
    const name = toNodeName('заимствование '.repeat(10));
    expect(utf8Length(name)).toBeLessThanOrEqual(NODE_NAME_MAX_UTF8_BYTES);
    expect(name.split('-').every((word) => word === 'заимствование')).toBe(true);
    // CJK: 3 bytes per character, a single long word is cut at a grapheme boundary.
    const cjk = toNodeName('漢'.repeat(80));
    expect(cjk).toBe('漢'.repeat(33));
    expect(utf8Length(cjk)).toBe(99);
  });

  it('never cuts inside a grapheme or an astral character', () => {
    // Devanagari clusters (base + marks) and astral letters (𠀀 is \p{L}, 4 bytes).
    expect(toNodeName('𠀀'.repeat(40))).toBe('𠀀'.repeat(25));
    for (const input of ['क्षि'.repeat(40), '𠀀'.repeat(40), 'é'.repeat(80)]) {
      const name = toNodeName(input);
      expect(isNodeName(name), input).toBe(true);
      expect(input.normalize('NFKC').toLowerCase().normalize('NFC').startsWith(name)).toBe(true);
      expect(graphemes(name).join('')).toBe(name);
      expect(name).not.toMatch(/[\uD800-\uDBFF]$/);
    }
  });

  it('property: always a valid node name, and idempotent', () => {
    let seed = 1234567;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const ranges: Array<[number, number]> = [
      [0x20, 0x7e],
      [0x300, 0x36f],
      [0x370, 0x52f],
      [0x900, 0x97f],
      [0x3040, 0x30ff],
      [0x4e00, 0x4fff],
      [0x200b, 0x206f],
      [0xff00, 0xffef],
      [0x1d400, 0x1d7ff],
      [0x1f300, 0x1faff],
    ];
    for (let i = 0; i < 3000; i++) {
      let input = '';
      const length = Math.floor(random() * 50);
      for (let j = 0; j < length; j++) {
        const [from, to] = ranges[Math.floor(random() * ranges.length)] ?? [0x20, 0x7e];
        input += String.fromCodePoint(from + Math.floor(random() * (to - from + 1)));
      }
      const name = toNodeName(input);
      expect(isNodeName(name), JSON.stringify(input)).toBe(true);
      expect(codePoints(name)).toBeLessThanOrEqual(NODE_NAME_MAX_CODE_POINTS);
      expect(utf8Length(name)).toBeLessThanOrEqual(NODE_NAME_MAX_UTF8_BYTES);
      expect(toNodeName(name), JSON.stringify(input)).toBe(name);
    }
  });
});

describe('isNodeName', () => {
  it('accepts ASCII slugs and Unicode names, with no length cap', () => {
    for (const name of [
      'a',
      'borrowing-rules',
      'a1-2b',
      'привет',
      'café-crème',
      'हिन्दी',
      'x'.repeat(300),
    ]) {
      expect(isNodeName(name), name).toBe(true);
    }
  });

  it('rejects NFD, uppercase, bad hyphens, dots, invisible characters', () => {
    for (const name of [
      '',
      'café'.normalize('NFD'),
      'Borrowing',
      'Привет',
      'a--b',
      '-a',
      'a-',
      'a b',
      'x.deleted-1759000000000',
      '.tmp-answer-x',
      'a‍b',
      'a‏b',
      '́a',
      'a/b',
      '👍',
    ]) {
      expect(isNodeName(name), JSON.stringify(name)).toBe(false);
    }
    expect(NODE_NAME_RE.test('Borrowing')).toBe(true);
  });
});

describe('nameKey', () => {
  it('folds like case-insensitive APFS', () => {
    expect(nameKey('straße')).toBe(nameKey('strasse'));
    expect(nameKey('λόγος')).toBe(nameKey('λόγοσ'));
    expect(nameKey('ﬁles')).toBe(nameKey('files'));
    expect(nameKey('Files')).toBe('files');
    expect(nameKey('café'.normalize('NFD'))).toBe(nameKey('café'));
  });

  it('keeps distinct letters apart', () => {
    expect(nameKey('ёлка')).not.toBe(nameKey('елка'));
    expect(nameKey('a')).not.toBe(nameKey('а')); // Latin vs Cyrillic
  });
});

describe('text helpers', () => {
  it('truncates by graphemes, with an optional ellipsis', () => {
    expect(truncateGraphemes('abc', 5)).toBe('abc');
    expect(truncateGraphemes('👩‍👩‍👧👍x', 2)).toBe('👩‍👩‍👧👍');
    expect(truncateGraphemes('hello world', 6, '…')).toBe('hello…');
  });

  it('first line and whitespace', () => {
    expect(firstLine('\n\n  first \nsecond')).toBe('first');
    expect(firstLine('  \r\n ')).toBe('');
    expect(collapseWhitespace('  a \t\n b  ')).toBe('a b');
  });
});
