import { describe, expect, it } from 'vitest';
import {
  type CiteRef,
  citeRefOf,
  citeUnitOf,
  pdfPageCount,
  pickRange,
  textLineCount,
  withCitations,
} from './cite';
import { loremAnswer } from './lorem';

// Mirrors contracts/prompt.ts (clickable-citations): a definition line is a `sources/` or
// `files/` ref (or URL) first, then nothing or whitespace + comment.
const PROMPT_EXAMPLE_FOOTNOTE_RE =
  /^\[\^[^\]\s]+\]: (?:(?:[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}-]*\/)*(?:sources|files)\/[^\s:]+(?: [^:]+?)?\.(?:md|txt|pdf):\d+(?:-\d+)?|https?:\/\/\S+)(?:\s+\S.*)?$/u;

const encode = (text: string) => new TextEncoder().encode(text);

function asciiPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => '<< /Type /Page /Parent 2 0 R >>'),
  ];
  return encode(`%PDF-1.4\n${objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('')}`);
}

/** A deterministic generator: cycles through the given fractions. */
function cycle(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

const definitionsOf = (text: string) =>
  text.split('\n').filter((line) => /^\[\^[^\]\s]+\]: /.test(line));

const chipKeys = (text: string) => [...text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)].map((m) => m[1]);

describe('pdfPageCount / textLineCount', () => {
  it('counts /Type /Page objects, not /Pages', () => {
    expect(pdfPageCount(asciiPdf(3))).toBe(3);
    expect(pdfPageCount(encode('%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 9 >>\nendobj\n'))).toBe(
      0,
    );
    expect(pdfPageCount(encode('not a pdf /Type /Page'))).toBe(0);
    expect(pdfPageCount(new Uint8Array([0, 255, 1]))).toBe(0);
  });

  it('counts lines ignoring one trailing newline', () => {
    expect(textLineCount('one\ntwo\nthree\n')).toBe(3);
    expect(textLineCount('one\ntwo\nthree')).toBe(3);
    expect(textLineCount('# Notes\n')).toBe(1);
    expect(textLineCount('')).toBe(0);
  });

  it('derives the unit from the name', () => {
    expect(citeUnitOf('guide.PDF')).toBe('page');
    expect(citeUnitOf('notes.md')).toBe('line');
    expect(citeUnitOf('notes.txt')).toBe('line');
    expect(citeUnitOf('photo.png')).toBe('none');
    expect(citeRefOf('sources/guide.pdf', 'guide.pdf', asciiPdf(2))).toEqual({
      path: 'sources/guide.pdf',
      unit: 'page',
      max: 2,
    });
    expect(citeRefOf('files/a.txt', 'a.txt', encode('x\ny\n'))).toEqual({
      path: 'files/a.txt',
      unit: 'line',
      max: 2,
    });
    expect(citeRefOf('files/p.png', 'p.png', new Uint8Array([1]))).toEqual({
      path: 'files/p.png',
      unit: 'none',
      max: 0,
    });
  });
});

describe('pickRange', () => {
  it('stays within 1..max, `:1` for an unknown size, nothing for unit none', () => {
    for (let i = 0; i < 200; i++) {
      const random = cycle([(i % 17) / 17, (i % 5) / 5, (i * 7) % 11 ? 0.9 : 0.1]);
      for (const unit of ['page', 'line'] as const) {
        const range = pickRange(random, 7, unit);
        const match = /^:(\d+)(?:-(\d+))?$/.exec(range);
        expect(match, range).not.toBeNull();
        const start = Number(match?.[1]);
        const end = Number(match?.[2] ?? match?.[1]);
        expect(start).toBeGreaterThanOrEqual(1);
        expect(end).toBeGreaterThanOrEqual(start);
        expect(end).toBeLessThanOrEqual(7);
      }
    }
    expect(pickRange(() => 0.5, 0, 'line')).toBe(':1');
    expect(pickRange(() => 0.99, 1, 'page')).toBe(':1');
    expect(pickRange(() => 0.5, 9, 'none')).toBe('');
  });
});

describe('withCitations', () => {
  const refs: CiteRef[] = [
    { path: 'sources/guide.pdf', unit: 'page', max: 3 },
    { path: 'sources/notes.md', unit: 'line', max: 12 },
    { path: 'files/photo.png', unit: 'none', max: 0 },
    { path: 'a/b/files/spec.txt', unit: 'line', max: 2 },
  ];

  it('returns the answer unchanged without refs', () => {
    const answer = loremAnswer(() => 0.5);
    expect(withCitations(answer, [], () => 0.5)).toBe(answer);
  });

  it('appends contract-shaped definitions and one chip per ref', () => {
    const random = cycle([0.5, 0.2, 0.8, 0.1, 0.6]);
    const answer = loremAnswer(random);
    const out = withCitations(answer, refs, random);
    const definitions = definitionsOf(out);
    expect(definitions).toHaveLength(refs.length);
    expect(out).toMatch(/\S\n\n\[\^1\]: /);
    expect(out.slice(out.indexOf('\n\n[^1]: ') + 2)).toBe(definitions.join('\n'));

    expect(definitions[0]).toMatch(/^\[\^1\]: sources\/guide\.pdf:(\d+)(?:-(\d+))? \([a-z ]+\)$/);
    const pdf = /:(\d+)(?:-(\d+))?/.exec(definitions[0] ?? '');
    expect(Number(pdf?.[2] ?? pdf?.[1])).toBeLessThanOrEqual(3);
    expect(definitions[1]).toMatch(
      /^\[\^2\]: sources\/notes\.md:(\d+)(?:-(\d+))?(?: \([a-z ]+\))?$/,
    );
    const md = /:(\d+)(?:-(\d+))?/.exec(definitions[1] ?? '');
    expect(Number(md?.[2] ?? md?.[1])).toBeLessThanOrEqual(12);
    expect(definitions[2]).toMatch(/^\[\^3\]: files\/photo\.png(?: \([a-z ]+\))?$/);
    expect(definitions[3]).toMatch(
      /^\[\^4\]: a\/b\/files\/spec\.txt:(?:1|2|1-2)(?: \([a-z ]+\))?$/,
    );
    for (const [i, line] of definitions.entries()) {
      if (i === 2) continue; // the no-range image form is outside the prompt-example grammar
      expect(line).toMatch(PROMPT_EXAMPLE_FOOTNOTE_RE);
    }

    const chips = chipKeys(out);
    expect([...new Set(chips)].sort()).toEqual(['1', '2', '3', '4']);
    expect(chips).toEqual(['1', '2', '3', '4']); // each chip once, in reading order
    expect(out).not.toMatch(/\S\[\^[^\]\s]+\]:/);
    const body = out.slice(0, out.indexOf('\n\n[^1]: '));
    expect(body).not.toMatch(/\[\^[^\]\s]+\]:/);
  });

  it('puts chips before a sentence period, never in code fences or list items', () => {
    const answer = [
      'First sentence here. Second one too.',
      '',
      '```rust',
      'let a = 1.',
      'fn f() -> u8 { 2 }.',
      '```',
      '',
      '- item one.',
      '- item two.',
      '',
      'Inline `code.` is skipped. Done.',
    ].join('\n');
    for (const seed of [0, 0.3, 0.5, 0.7, 0.999]) {
      const out = withCitations(answer, refs, () => seed);
      const body = out.slice(0, out.indexOf('\n\n[^1]: '));
      let inFence = false;
      for (const line of body.split('\n')) {
        if (/^```/.test(line)) inFence = !inFence;
        if (inFence || /^```/.test(line) || /^- /.test(line)) {
          expect(line).not.toMatch(/\[\^/);
        }
      }
      for (const match of body.matchAll(/\[\^\d+\]/g)) {
        const after = body.slice(match.index + match[0].length);
        expect(after.startsWith('.') || after.startsWith('[^')).toBe(true);
      }
      expect(body).not.toMatch(/`code\.\[\^/);
      expect(chipKeys(out).sort()).toEqual(['1', '2', '3', '4']);
    }
  });

  it('falls back to a closing sentence when there is no prose to cite', () => {
    const out = withCitations('```\ncode.\n```', refs.slice(0, 2), () => 0.5);
    expect(out).toMatch(/\n\nLorem ipsum dolor sit amet\[\^1\]\[\^2\]\.\n\n\[\^1\]: /);
  });

  it('is deterministic for a given random source', () => {
    const answer = loremAnswer(() => 0.42);
    expect(withCitations(answer, refs, cycle([0.1, 0.9, 0.4]))).toBe(
      withCitations(answer, refs, cycle([0.1, 0.9, 0.4])),
    );
  });
});
