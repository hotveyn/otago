import { describe, expect, it } from 'vitest';
import {
  SUGGESTIONS_MARKER,
  SuggestionBlockFilter,
  splitSuggestionBlock,
  suggestionBlock,
} from '../src/storage/index.js';

const M = SUGGESTIONS_MARKER;

describe('splitSuggestionBlock', () => {
  it('returns the text unchanged without a marker', () => {
    const text = 'Just an answer.\n\n- a list\n- of items';
    expect(splitSuggestionBlock(text)).toEqual({ answer: text, rejected: false });
    expect(splitSuggestionBlock(text).items).toBeUndefined();
    expect(splitSuggestionBlock('')).toEqual({ answer: '', rejected: false });
  });

  it('cuts a block at the end; the answer loses its trailing whitespace', () => {
    const text = `Answer [^1].\n\n[^1]: sources/a.md:1-2\n\n${M}\n- Перейти к главе 4\n- Second part`;
    expect(splitSuggestionBlock(text)).toEqual({
      answer: 'Answer [^1].\n\n[^1]: sources/a.md:1-2',
      items: ['Перейти к главе 4', 'Second part'],
      rejected: false,
    });
  });

  it('a marker alone at the end is an empty block', () => {
    expect(splitSuggestionBlock(`Answer\n\n${M}`)).toEqual({
      answer: 'Answer',
      items: [],
      rejected: false,
    });
    expect(splitSuggestionBlock(`Answer\n${M}\n\n`).items).toEqual([]);
  });

  it('accepts trailing newlines, CRLF and blank lines between items', () => {
    expect(splitSuggestionBlock(`A\n${M}\n- x\n- y\n`).items).toEqual(['x', 'y']);
    expect(splitSuggestionBlock(`A\r\n\r\n${M}\r\n- x\r\n\r\n- y\r\n`)).toEqual({
      answer: 'A',
      items: ['x', 'y'],
      rejected: false,
    });
    expect(splitSuggestionBlock(`A\n${M}\n\n- x\n   \n\t\n- y`).items).toEqual(['x', 'y']);
  });

  it('accepts every bullet kind; an empty item is ""', () => {
    const items = ['- a', '* b', '+ c', '• d', '1. e', '12) f', '  - g  ', '-', '- '];
    expect(splitSuggestionBlock(`A\n${M}\n${items.join('\n')}`).items).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      '',
      '',
    ]);
  });

  it('accepts marker spacing variants; case matters', () => {
    for (const marker of ['<!--otago:suggestions-->', '   <!--  otago:suggestions\t-->  ']) {
      expect(splitSuggestionBlock(`A\n${marker}\n- x`).items, marker).toEqual(['x']);
    }
    const upper = 'A\n<!-- OTAGO:suggestions -->\n- x';
    expect(splitSuggestionBlock(upper)).toEqual({ answer: upper, rejected: false });
  });

  it('a marker inside a fence is kept (``` and ~~~, longer fences, unclosed fence)', () => {
    for (const text of [
      `Intro\n\`\`\`md\n${M}\n- x\n\`\`\``,
      `Intro\n~~~\n${M}\n- x\n~~~`,
      `Intro\n\`\`\`\`\n\`\`\`\n${M}\n- x`,
      `Intro\n\`\`\`\n${M}\n- x`,
      `Intro\n~~~\n\`\`\`\n${M}\n- x`,
    ]) {
      expect(splitSuggestionBlock(text), text).toEqual({ answer: text, rejected: false });
    }
    // A block after a closed fence counts.
    expect(splitSuggestionBlock(`\`\`\`\ncode\n\`\`\`\n${M}\n- x`).items).toEqual(['x']);
  });

  it('a marker followed by prose, a footnote or a closing fence is kept, rejected', () => {
    for (const text of [
      `Intro\n${M}\n- x\nMore prose.`,
      `Intro\n${M}\n- x\n\n[^1]: sources/a.md:1-2`,
      `Intro\n${M}\n\`\`\``,
      `Intro\n${M}\n---`,
      `Intro\n${M}\n- x\n***`,
      `Intro\n${M}\n-text`,
    ]) {
      expect(splitSuggestionBlock(text), text).toEqual({ answer: text, rejected: true });
    }
  });

  it('with two blocks the last one wins and the first stays as text', () => {
    const text = `Intro\n${M}\n- first\nProse\n\n${M}\n- second`;
    expect(splitSuggestionBlock(text)).toEqual({
      answer: `Intro\n${M}\n- first\nProse`,
      items: ['second'],
      rejected: true,
    });
    // A marker right after a block's items starts the next block.
    expect(splitSuggestionBlock(`Intro\n${M}\n- a\n${M}\n- b`)).toEqual({
      answer: `Intro\n${M}\n- a`,
      items: ['b'],
      rejected: true,
    });
  });

  it('round-trips suggestionBlock()', () => {
    expect(suggestionBlock(['a', 'b'])).toBe(`\n\n${M}\n- a\n- b`);
    expect(suggestionBlock([])).toBe(`\n\n${M}`);
    for (const texts of [[], ['Перейти к главе 4'], ['1. odd', '- dash', 'x']]) {
      const answer = 'Answer with a list:\n\n- one\n- two';
      expect(splitSuggestionBlock(answer + suggestionBlock(texts))).toEqual({
        answer,
        items: texts,
        rejected: false,
      });
    }
  });
});

/** Every text the filter must handle, with block, without, rejected, fenced, two blocks. */
const TEXTS = [
  'Plain answer without any marker.\nSecond line.',
  `Answer [^1].\n\n[^1]: sources/a.md:1-2${suggestionBlock(['Глава 4', 'Part two'])}`,
  `Answer${suggestionBlock([])}`,
  `Answer\r\n\r\n${M}\r\n- x\r\n`,
  `Intro\n${M}\n- x\nMore prose after the marker.`,
  `Intro\n\`\`\`md\n${M}\n- x\n\`\`\`\nAfter.`,
  `Intro\n${M}\n- first\nProse\n${M}\n- second\n`,
  `Intro\n${M}\n- a\n${M}\n- b`,
  `<b>bold</b> line\n<!-- a comment -->\n  <!-- otago:suggestions --> trailing\nend`,
  `Ends with an incomplete marker <!-- otago:sugg`,
];

function expectedOutput(text: string): string {
  const split = splitSuggestionBlock(text);
  if (split.items === undefined) return text;
  // Start of the final marker line: the last marker line of the text.
  const lines = text.split('\n');
  let offset = 0;
  let start = -1;
  for (const line of lines) {
    if (/^[ \t]*<!--[ \t]*otago:suggestions[ \t]*-->[ \t]*\r?$/.test(line)) start = offset;
    offset += line.length + 1;
  }
  return text.slice(0, start);
}

function runFilter(chunks: string[]): { outputs: string[]; final: string } {
  const filter = new SuggestionBlockFilter();
  const outputs: string[] = [];
  let total = '';
  for (const chunk of chunks) {
    total += filter.push(chunk);
    outputs.push(total);
  }
  total += filter.end();
  outputs.push(total);
  return { outputs, final: total };
}

function chunkings(text: string): string[][] {
  const all: string[][] = [[text], Array.from(text)];
  for (let offset = 0; offset <= text.length; offset++) {
    all.push([text.slice(0, offset), text.slice(offset)]);
  }
  return all;
}

describe('SuggestionBlockFilter', () => {
  it('for every chunking: emits the text without the final block, never retracting', () => {
    for (const text of TEXTS) {
      const expected = expectedOutput(text);
      const hasBlock = splitSuggestionBlock(text).items !== undefined;
      for (const chunks of chunkings(text)) {
        const { outputs, final } = runFilter(chunks);
        expect(final, JSON.stringify(chunks)).toBe(expected);
        for (const output of outputs) expect(final.startsWith(output)).toBe(true);
        // With a block (and no other comment before it), no emitted text contains `<!--`.
        if (hasBlock && !expected.includes('<!--')) {
          for (const output of outputs) expect(output).not.toContain('<!--');
        }
      }
    }
  });

  it('never emits any part of the final marker line', () => {
    const answer = 'Answer text.';
    const text = `${answer}${suggestionBlock(['a'])}`;
    for (const chunks of chunkings(text)) {
      const { outputs } = runFilter(chunks);
      for (const output of outputs) {
        expect(output).not.toContain('<');
        expect(output).not.toContain('- a');
      }
    }
  });

  it('emits text without `<` at once, per chunk', () => {
    const filter = new SuggestionBlockFilter();
    expect(filter.push('Hello, ')).toBe('Hello, ');
    expect(filter.push('world.\nNext')).toBe('world.\nNext');
    expect(filter.push(' line')).toBe(' line');
    expect(filter.end()).toBe('');
  });

  it('holds a line that may still become a marker until its newline', () => {
    const filter = new SuggestionBlockFilter();
    expect(filter.push('Intro\n  <')).toBe('Intro\n');
    expect(filter.push('!--x')).toBe('');
    expect(filter.push(' -->')).toBe('');
    expect(filter.push('\nAfter')).toBe('  <!--x -->\nAfter');
    expect(filter.end()).toBe('');
  });

  it('releases a `<b>` line at once (not a prefix of `<!--`)', () => {
    const filter = new SuggestionBlockFilter();
    expect(filter.push('<b>bold</b>')).toBe('<b>bold</b>');
    expect(filter.push('\n<')).toBe('\n');
    expect(filter.push('i')).toBe('<i');
    expect(filter.end()).toBe('');
  });

  it('holds a candidate block until a line breaks it, then releases it', () => {
    const filter = new SuggestionBlockFilter();
    expect(filter.push(`Intro\n${M}\n- x\n`)).toBe('Intro\n');
    expect(filter.push('\n- y\n')).toBe('');
    expect(filter.push('Pro')).toBe('');
    expect(filter.push('se\n')).toBe(`${M}\n- x\n\n- y\nProse\n`);
    expect(filter.end()).toBe('');
  });

  it('emits everything inside a fence at once', () => {
    const filter = new SuggestionBlockFilter();
    expect(filter.push('```\n<!-- otago:sugg')).toBe('```\n<!-- otago:sugg');
    expect(filter.push('estions -->\n```\n<')).toBe('estions -->\n```\n');
    expect(filter.end()).toBe('<');
  });

  it('withholds the final block at end(); a held non-marker line is released', () => {
    const block = new SuggestionBlockFilter();
    expect(block.push(`A\n${M}\n- x`)).toBe('A\n');
    expect(block.end()).toBe('');
    const partial = new SuggestionBlockFilter();
    expect(partial.push('A\n<!-- otago:sugg')).toBe('A\n');
    expect(partial.end()).toBe('<!-- otago:sugg');
  });
});
