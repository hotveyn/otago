import { describe, expect, it } from 'vitest';
import { isFenceClosed } from './fences';

const whole = (markdown: string) => ({ start: { offset: 0 }, end: { offset: markdown.length } });

describe('isFenceClosed', () => {
  it('detects a closed fence', () => {
    const md = '```mermaid\ngraph TD\nA-->B\n```';
    expect(isFenceClosed(md, whole(md))).toBe(true);
  });

  it('detects an unclosed streaming tail', () => {
    const md = '```mermaid\ngraph TD\nA-->';
    expect(isFenceClosed(md, whole(md))).toBe(false);
    expect(isFenceClosed('```csv', whole('```csv'))).toBe(false);
  });

  it('supports tilde fences and requires the same marker', () => {
    const closed = '~~~csv\na,b\n~~~';
    expect(isFenceClosed(closed, whole(closed))).toBe(true);
    const mixed = '~~~csv\na,b\n```';
    expect(isFenceClosed(mixed, whole(mixed))).toBe(false);
  });

  it('accepts a longer closing marker but not a shorter one', () => {
    const longer = '```csv\na,b\n`````';
    expect(isFenceClosed(longer, whole(longer))).toBe(true);
    const shorter = '````csv\na,b\n```';
    expect(isFenceClosed(shorter, whole(shorter))).toBe(false);
  });

  it('uses offsets into a larger document', () => {
    const block = '```csv\na,b\n```';
    const md = `Intro\n\n${block}\n\nMore text`;
    const start = md.indexOf(block);
    expect(
      isFenceClosed(md, { start: { offset: start }, end: { offset: start + block.length } }),
    ).toBe(true);
  });

  it('treats unknown positions and indented code as closed', () => {
    expect(isFenceClosed('```x', undefined)).toBe(true);
    const indented = '    code';
    expect(isFenceClosed(indented, whole(indented))).toBe(true);
  });

  it('handles fences inside blockquotes', () => {
    const md = '> ```csv\n> a,b\n> ```';
    expect(isFenceClosed(md, whole(md))).toBe(true);
  });
});
