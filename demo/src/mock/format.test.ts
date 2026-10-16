import { describe, expect, it } from 'vitest';
import { setSuggestionsLine } from '../../../server/src/storage/suggestions';
import {
  type NodeFile,
  parseNodeFile,
  parseTreeFile,
  serializeNodeFile,
  serializeTreeFile,
} from './format';

describe('format', () => {
  it('round-trips tree.md, quoting titles YAML would misread', () => {
    for (const title of ['Rust ownership', 'Rust: ownership', 'yes', "It's #1", 'Учим Rust']) {
      const tree = { title, created: '2026-01-01T00:00:00.000Z', instructions: 'Be brief.' };
      expect(parseTreeFile(serializeTreeFile(tree))).toEqual(tree);
    }
  });

  it('reads what gray-matter writes on the server', () => {
    const tree = parseTreeFile(
      "---\ntitle: 'Rust: it''s fine'\ncreated: 2026-09-26T09:08:36.701Z\n---\n\nBody\n",
    );
    expect(tree).toEqual({
      title: "Rust: it's fine",
      created: '2026-09-26T09:08:36.701Z',
      instructions: 'Body',
    });
  });

  it('round-trips node.md with markers and multi-line text', () => {
    const node = {
      created: '2026-01-01T00:00:00.000Z',
      model: 'claude-opus-5-5',
      user: 'Line 1\n\nLine 2',
      assistant: '```rust\nfn main() {}\n```',
    };
    expect(parseNodeFile(serializeNodeFile(node))).toEqual(node);
  });

  it('rejects node.md without markers', () => {
    expect(() => parseNodeFile('---\ncreated: 2026-01-01T00:00:00.000Z\n---\ntext')).toThrow(
      /markers/,
    );
  });
});

describe('format: suggestions', () => {
  const base: NodeFile = {
    created: '2026-01-01T00:00:00.000Z',
    model: 'claude-opus-5-5',
    user: 'Q?',
    assistant: 'A.',
  };
  const PRE_FEATURE =
    '---\ncreated: 2026-01-01T00:00:00.000Z\nmodel: claude-opus-5-5\n---\n<!-- otago:user -->\nQ?\n\n<!-- otago:assistant -->\nA.\n';
  const withLine = (value: string) =>
    PRE_FEATURE.replace('model: claude-opus-5-5\n', `model: claude-opus-5-5\n${value}\n`);

  it('keeps old nodes as they are: no property, byte-identical output', () => {
    const parsed = parseNodeFile(PRE_FEATURE);
    expect(parsed).toEqual(base);
    expect('suggestions' in parsed).toBe(false);
    expect(serializeNodeFile(base)).toBe(PRE_FEATURE);
    expect(serializeNodeFile(parsed)).toBe(PRE_FEATURE);
  });

  it('reads a stored empty list', () => {
    expect(parseNodeFile(withLine('suggestions: []')).suggestions).toEqual([]);
  });

  it('round-trips texts with colons, hashes, quotes, backslashes and Cyrillic', () => {
    const suggestions = [
      { text: 'Rust: why?', up: 0 },
      { text: 'Item #2 "quoted" it\'s', up: 0 },
      { text: 'Path C:\\dir\\file', up: 1 },
      { text: 'Перейдём к главе 2', up: 2 },
    ];
    const node = { ...base, suggestions };
    expect(parseNodeFile(serializeNodeFile(node))).toEqual(node);
  });

  it('keeps U+2028 out of the line: escaped on write, sanitized to a space on read', () => {
    const text = serializeNodeFile({ ...base, suggestions: [{ text: 'a\u2028b', up: 0 }] });
    const line = text.split('\n').find((l) => l.startsWith('suggestions:')) ?? '';
    expect(line).not.toContain('\u2028');
    expect(line).toContain('\\u2028');
    expect(parseNodeFile(text).suggestions).toEqual([{ text: 'a b', up: 0 }]);
  });

  it('treats every other value as MISSING', () => {
    for (const value of [
      'suggestions: null',
      'suggestions: "[]"',
      "suggestions: '[]'",
      'suggestions: {}',
      'suggestions: [{"text":',
      'suggestions:',
      'suggestions:\n  - text: x\n    up: 0',
    ]) {
      const parsed = parseNodeFile(withLine(value));
      expect(parsed.suggestions, value).toBeUndefined();
      expect('suggestions' in parsed, value).toBe(false);
    }
  });

  it('drops invalid items, keeps the list stored and ignores unknown keys', () => {
    const value = JSON.stringify([
      { text: 'Good', up: 0, extra: 'future' },
      { text: 'F', up: 0, kind: 'future' },
      { text: 'N', up: 0, kind: null },
      { text: 'W0', up: 0, kind: 'whole' },
      { text: 'W2', up: 2, kind: 'whole' },
      { text: 'W', up: 1, kind: 'whole' },
      { text: '', up: 0 },
      { text: 'Neg', up: -1 },
      { text: 'Frac', up: 1.5 },
      { up: 0 },
      'bare',
      { text: '  "Quoted"  ', up: 1 },
    ]);
    expect(parseNodeFile(withLine(`suggestions: ${value}`)).suggestions).toEqual([
      { text: 'Good', up: 0 },
      { text: 'W', up: 1, kind: 'whole' },
      { text: 'Quoted', up: 1 },
    ]);
    expect(parseNodeFile(withLine('suggestions: [{"text":""}]')).suggestions).toEqual([]);
  });

  it('writes through setSuggestionsLine: the line is the last frontmatter line', () => {
    const suggestions = [{ text: 'Next?', up: 0 }];
    const text = serializeNodeFile({ ...base, suggestions });
    expect(text).toBe(setSuggestionsLine(serializeNodeFile(base), suggestions));
    expect(text).toBe(withLine('suggestions: [{"text":"Next?","up":0}]'));
    const lines = text.split('\n');
    expect(lines[lines.indexOf('---', 1) - 1]).toBe('suggestions: [{"text":"Next?","up":0}]');
    expect(serializeNodeFile({ ...base, suggestions: [] })).toBe(withLine('suggestions: []'));
  });

  it("writes and reads a whole item in the server's form", () => {
    const suggestions = [
      { text: 'P', up: 0 },
      { text: 'W', up: 1, kind: 'whole' as const },
    ];
    const text = serializeNodeFile({ ...base, suggestions });
    expect(text).toBe(
      withLine('suggestions: [{"text":"P","up":0},{"text":"W","up":1,"kind":"whole"}]'),
    );
    expect(parseNodeFile(text)).toEqual({ ...base, suggestions });
  });

  it('reads the server-written form (gray-matter frontmatter + spliced line)', () => {
    const server =
      '---\ncreated: \'2026-01-01T00:00:00.000Z\'\nmodel: claude-opus-5-5\nsuggestions: [{"text":"Перейдём к главе 2","up":1},{"text":"Что такое заимствование?","up":0}]\n---\n<!-- otago:user -->\nQ?\n\n<!-- otago:assistant -->\nA.\n';
    expect(parseNodeFile(server)).toEqual({
      ...base,
      suggestions: [
        { text: 'Перейдём к главе 2', up: 1 },
        { text: 'Что такое заимствование?', up: 0 },
      ],
    });
    expect(parseNodeFile(server.replaceAll('\n', '\r\n')).suggestions).toHaveLength(2);
  });
});
