import { describe, expect, it } from 'vitest';
import {
  finalizeSuggestions,
  type NodeFile,
  parseNodeFile,
  parseStoredSuggestions,
  pickCandidates,
  removeSuggestionsLine,
  resolveSuggestions,
  SUGGESTION_MAX_GRAPHEMES,
  type SuggestionChainNode,
  sanitizeSuggestionText,
  serializeNodeFile,
  setSuggestionsLine,
  suggestionKey,
  suggestionsLine,
  suggestionTargets,
} from '../src/storage/index.js';
import { graphemes } from '../src/text.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);
const REPLACEMENT = String.fromCharCode(0xfffd);
const ACUTE = String.fromCharCode(0x301);
const MINUS_BELOW = String.fromCharCode(0x320);

const OLD_NODE = `---
created: 2026-09-23T10:00:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
What is borrowing?

<!-- otago:assistant -->
Borrowing lets you reference a value.
`;

const base: NodeFile = {
  created: '2026-09-23T10:00:00.000Z',
  model: 'claude-opus-5-5',
  user: 'What is borrowing?',
  assistant: 'Borrowing lets you reference a value.',
};

describe('suggestionKey', () => {
  it('trims and normalizes to NFC, case-sensitive', () => {
    expect(suggestionKey(`  e${ACUTE}  `)).toBe('é'.normalize('NFC'));
    expect(suggestionKey('Глава 2')).not.toBe(suggestionKey('глава 2'));
  });
});

describe('sanitizeSuggestionText', () => {
  it('collapses whitespace, newlines and line separators', () => {
    expect(sanitizeSuggestionText(`  a\n\tb ${LS} c${PS}d  `)).toBe('a b c d');
  });

  it('strips one pair of wrapping quotes', () => {
    expect(sanitizeSuggestionText('"Глава 2"')).toBe('Глава 2');
    expect(sanitizeSuggestionText('« Перейдём к главе 2 »')).toBe('Перейдём к главе 2');
    expect(sanitizeSuggestionText('“next”')).toBe('next');
    expect(sanitizeSuggestionText('„weiter“')).toBe('weiter');
    expect(sanitizeSuggestionText("'x'")).toBe('x');
    expect(sanitizeSuggestionText('""a""')).toBe('"a"');
    expect(sanitizeSuggestionText('"a" and "b"')).toBe('a" and "b');
    expect(sanitizeSuggestionText('say "hi"')).toBe('say "hi"');
  });

  it('applies NFC and fixes lone surrogates', () => {
    const nfd = 'Перейдём'.normalize('NFD');
    expect(sanitizeSuggestionText(nfd)).toBe('Перейдём'.normalize('NFC'));
    expect(sanitizeSuggestionText(`a${LONE_HIGH}b${LONE_LOW}`)).toBe(
      `a${REPLACEMENT}b${REPLACEMENT}`,
    );
    expect(sanitizeSuggestionText('😀')).toBe('😀');
  });

  it('cuts at the grapheme cap without splitting emoji or combining sequences', () => {
    const family = '👨‍👩‍👧';
    const cut = sanitizeSuggestionText(family.repeat(SUGGESTION_MAX_GRAPHEMES + 5));
    expect(cut).toBe(family.repeat(SUGGESTION_MAX_GRAPHEMES));
    const combining = `e${ACUTE}`;
    // NFC composes `é`; a sequence with no precomposed form stays one grapheme.
    const cluster = `a${ACUTE}${MINUS_BELOW}${combining}`;
    const text = sanitizeSuggestionText(cluster.repeat(300)) ?? '';
    expect(graphemes(text)).toHaveLength(SUGGESTION_MAX_GRAPHEMES);
    expect(graphemes(text).every((part) => part.normalize('NFC') === part)).toBe(true);
  });

  it('returns null for empty or non-string input', () => {
    expect(sanitizeSuggestionText('   ')).toBeNull();
    expect(sanitizeSuggestionText('""')).toBeNull();
    expect(sanitizeSuggestionText(42)).toBeNull();
    expect(sanitizeSuggestionText(undefined)).toBeNull();
  });
});

describe('parseStoredSuggestions', () => {
  it('missing for absent or non-array values', () => {
    for (const value of [undefined, null, 'x', { text: 'a', up: 0 }, 1]) {
      expect(parseStoredSuggestions(value)).toBeUndefined();
    }
  });

  it('stored for arrays, dropping invalid items and re-sanitizing texts', () => {
    expect(parseStoredSuggestions([])).toEqual([]);
    expect(
      parseStoredSuggestions([
        { text: '  a\nb ', up: 0, kind: 'extra' },
        { text: '', up: 0 },
        { text: 5, up: 0 },
        { text: 'neg', up: -1 },
        { text: 'frac', up: 1.5 },
        { text: 'str', up: '1' },
        { up: 1 },
        'bare',
        null,
        { text: 'ok', up: 2 },
      ]),
    ).toEqual([
      { text: 'a b', up: 0 },
      { text: 'ok', up: 2 },
    ]);
  });
});

describe('suggestionsLine', () => {
  it('is one JSON line with U+2028 / U+2029 escaped', () => {
    const line = suggestionsLine([{ text: `a${LS}b${PS}c`, up: 0 }]);
    expect(line).not.toContain(LS);
    expect(line).not.toContain(PS);
    expect(line).not.toContain('\n');
    expect(line).toBe('suggestions: [{"text":"a\\u2028b\\u2029c","up":0}]');
    expect(line.startsWith('suggestions: [')).toBe(true);
    expect(JSON.parse(line.slice('suggestions: '.length))).toEqual([
      { text: `a${LS}b${PS}c`, up: 0 },
    ]);
  });

  it('writes only text and up', () => {
    const items = [{ text: 'a', up: 1, extra: true }] as unknown as { text: string; up: number }[];
    expect(suggestionsLine(items)).toBe('suggestions: [{"text":"a","up":1}]');
  });

  it('round-trips through the node.md parser', () => {
    const items = [
      { text: 'Перейдём к главе 2', up: 1 },
      { text: 'What does # mean: here?', up: 0 },
      { text: `He said "hi" \\ 'there' - [x] {y}`, up: 0 },
      { text: `sep${LS}arated`, up: 3 },
    ];
    const text = serializeNodeFile({ ...base, suggestions: items });
    expect(parseNodeFile(text)).toEqual({
      ...base,
      // Re-sanitized on read: U+2028 is whitespace.
      suggestions: [...items.slice(0, 3), { text: 'sep arated', up: 3 }],
    });
  });
});

describe('setSuggestionsLine', () => {
  const withoutLine = (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.startsWith('suggestions:'))
      .join('\n');

  it('inserts before the closing --- and keeps every other byte', () => {
    const after = setSuggestionsLine(OLD_NODE, [{ text: 'Глава 2', up: 1 }]);
    expect(after).toBe(
      OLD_NODE.replace(
        'model: claude-opus-5-5\n---',
        'model: claude-opus-5-5\nsuggestions: [{"text":"Глава 2","up":1}]\n---',
      ),
    );
    expect(withoutLine(after)).toBe(OLD_NODE);
  });

  it('replaces an existing single line in place', () => {
    const text = OLD_NODE.replace('created:', 'suggestions: nope\ncreated:');
    expect(setSuggestionsLine(text, [])).toBe(
      OLD_NODE.replace('created:', 'suggestions: []\ncreated:'),
    );
  });

  it('replaces a block-style YAML list with its continuation lines', () => {
    const text = OLD_NODE.replace(
      'model: claude-opus-5-5\n',
      'suggestions:\n- text: a\n  up: 0\n-   text: b\n    up: 1\nmodel: claude-opus-5-5\n',
    );
    expect(parseNodeFile(text).suggestions).toEqual([
      { text: 'a', up: 0 },
      { text: 'b', up: 1 },
    ]);
    const after = setSuggestionsLine(text, [{ text: 'c', up: 0 }]);
    expect(after).toBe(
      OLD_NODE.replace(
        'model: claude-opus-5-5\n',
        'suggestions: [{"text":"c","up":0}]\nmodel: claude-opus-5-5\n',
      ),
    );
  });

  it('keeps CRLF files CRLF', () => {
    const crlf = OLD_NODE.replace(/\n/g, '\r\n');
    const after = setSuggestionsLine(crlf, []);
    expect(after).toBe(
      crlf.replace('claude-opus-5-5\r\n---', 'claude-opus-5-5\r\nsuggestions: []\r\n---'),
    );
    expect(parseNodeFile(after).suggestions).toEqual([]);
  });

  it('ignores a suggestions line in the body', () => {
    const text = OLD_NODE.replace('Borrowing lets', 'suggestions: [] lets');
    const after = setSuggestionsLine(text, []);
    expect(after.match(/^suggestions:/gm)).toHaveLength(2);
    expect(after.indexOf('suggestions: []\n---')).toBeGreaterThan(0);
  });

  it('throws without frontmatter', () => {
    expect(() => setSuggestionsLine('no frontmatter', [])).toThrow();
    expect(() => setSuggestionsLine('---\nunclosed: 1\n', [])).toThrow();
  });

  it('removeSuggestionsLine undoes it', () => {
    const after = setSuggestionsLine(OLD_NODE, [{ text: 'x', up: 0 }]);
    expect(removeSuggestionsLine(after)).toBe(OLD_NODE);
    expect(removeSuggestionsLine(OLD_NODE)).toBe(OLD_NODE);
  });
});

describe('node.md with suggestions', () => {
  it('serializes a node without suggestions exactly like before', async () => {
    expect(serializeNodeFile(base)).toBe(OLD_NODE);
    const parsed = parseNodeFile(OLD_NODE);
    expect(parsed).toEqual(base);
    expect('suggestions' in parsed).toBe(false);
  });

  it('writes `suggestions: []` for a stored empty list', () => {
    const text = serializeNodeFile({ ...base, suggestions: [] });
    expect(text).toBe(
      OLD_NODE.replace('claude-opus-5-5\n---', 'claude-opus-5-5\nsuggestions: []\n---'),
    );
    expect(parseNodeFile(text).suggestions).toEqual([]);
  });

  it('treats a non-array value as missing', () => {
    for (const value of ['null', 'nope', '{ text: a }', '']) {
      const text = OLD_NODE.replace('model:', `suggestions: ${value}\nmodel:`);
      expect(parseNodeFile(text).suggestions).toBeUndefined();
    }
  });

  it('a broken suggestions value does not make the node unreadable', () => {
    const text = OLD_NODE.replace('model:', 'suggestions: [{"text": \nmodel:');
    expect(parseNodeFile(text)).toEqual(base);
  });
});

/** Chain records; a node's question defaults to `q:<id>`. */
const chainOf = (
  ...nodes: Array<[string, SuggestionChainNode['suggestions'], string?]>
): SuggestionChainNode[] =>
  nodes.map(([id, suggestions, user = `q:${id}`]) =>
    suggestions ? { id, user, suggestions } : { id, user },
  );

const noUsed = new Map<string, Set<string>>();

describe('resolveSuggestions', () => {
  it('[] when no node of the chain has a list', () => {
    expect(resolveSuggestions(chainOf(['a', undefined], ['a/b', undefined]), noUsed)).toEqual([]);
    expect(resolveSuggestions([], noUsed)).toEqual([]);
    expect(suggestionTargets(chainOf(['a', undefined]))).toEqual([]);
  });

  it('own items target the node; inherited ones the ancestor that owns them', () => {
    const chain = chainOf(
      [
        'plan',
        [
          { text: 'Глава 2', up: 0 },
          { text: 'Глава 3', up: 0 },
        ],
      ],
      [
        'plan/ch1',
        [
          { text: 'Deeper', up: 0 },
          { text: 'Глава 3', up: 1 },
        ],
      ],
      [
        'plan/ch1/deep',
        [
          { text: 'Own', up: 0 },
          { text: 'Deeper', up: 1 },
          { text: 'Глава 2', up: 2 },
        ],
      ],
    );
    expect(resolveSuggestions(chain, noUsed)).toEqual([
      { text: 'Own', target: 'plan/ch1/deep', up: 0 },
      { text: 'Deeper', target: 'plan/ch1', up: 1 },
      { text: 'Глава 2', target: 'plan', up: 2 },
    ]);
    expect(suggestionTargets(chain)).toEqual(['plan/ch1/deep', 'plan/ch1', 'plan']);
  });

  it('a node without a list uses its nearest stored ancestor, `up` shifted', () => {
    const chain = chainOf(
      [
        'plan',
        [
          { text: 'Глава 2', up: 0 },
          { text: 'Глава 3', up: 0 },
        ],
      ],
      [
        'plan/ch1',
        [
          { text: 'Deeper', up: 0 },
          { text: 'Глава 3', up: 1 },
        ],
      ],
      ['plan/ch1/legacy', undefined],
      ['plan/ch1/legacy/more', undefined],
    );
    expect(resolveSuggestions(chain, noUsed)).toEqual([
      { text: 'Deeper', target: 'plan/ch1', up: 2 },
      { text: 'Глава 3', target: 'plan', up: 3 },
    ]);
    expect(suggestionTargets(chain)).toEqual(['plan/ch1', 'plan']);
    expect(resolveSuggestions(chain.slice(0, 3), noUsed)).toEqual([
      { text: 'Deeper', target: 'plan/ch1', up: 1 },
      { text: 'Глава 3', target: 'plan', up: 2 },
    ]);
  });

  it('a stored [] stops the fallback', () => {
    const chain = chainOf(
      ['plan', [{ text: 'A', up: 0 }]],
      ['plan/x', []],
      ['plan/x/y', undefined],
    );
    expect(resolveSuggestions(chain, noUsed)).toEqual([]);
    expect(resolveSuggestions(chain.slice(0, 2), noUsed)).toEqual([]);
    expect(suggestionTargets(chain)).toEqual([]);
  });

  it('the fallback drops items asked by a node below the owner', () => {
    const chain = chainOf(
      [
        'plan',
        [
          { text: 'Глава 2', up: 0 },
          { text: 'Глава 3', up: 0 },
        ],
      ],
      ['plan/ch2', undefined, ' Глава 2 '],
      ['plan/ch2/deep', undefined, 'Something else'],
    );
    expect(resolveSuggestions(chain, noUsed)).toEqual([{ text: 'Глава 3', target: 'plan', up: 2 }]);
    // Its own list is not filtered by its own question.
    expect(resolveSuggestions(chainOf(['p', [{ text: 'q:p', up: 0 }]]), noUsed)).toEqual([
      { text: 'q:p', target: 'p', up: 0 },
    ]);
  });

  it('drops inherited items that no longer resolve', () => {
    const items = [
      { text: 'root', up: 2 },
      { text: 'gone', up: 1 },
      { text: 'not-owned', up: 1 },
      { text: 'kept', up: 1 },
    ];
    // Parent without a list.
    expect(resolveSuggestions(chainOf(['p', undefined], ['p/n', items]), noUsed)).toEqual([]);
    // Parent's own list lacks the text (moved under another parent), or only inherits it.
    expect(
      resolveSuggestions(
        chainOf(
          [
            'p',
            [
              { text: 'kept', up: 0 },
              { text: 'not-owned', up: 1 },
            ],
          ],
          ['p/n', items],
        ),
        noUsed,
      ),
    ).toEqual([{ text: 'kept', target: 'p', up: 1 }]);
  });

  it('own wins over an inherited duplicate; used items are dropped per target', () => {
    const chain = chainOf(
      [
        'p',
        [
          { text: 'dup', up: 0 },
          { text: 'used', up: 0 },
          { text: 'free', up: 0 },
        ],
      ],
      [
        'p/n',
        [
          { text: 'dup', up: 0 },
          { text: 'dup', up: 1 },
          { text: 'used', up: 1 },
          { text: 'free', up: 1 },
        ],
      ],
    );
    expect(resolveSuggestions(chain, new Map([['p', new Set(['used'])]]))).toEqual([
      { text: 'dup', target: 'p/n', up: 0 },
      { text: 'free', target: 'p', up: 1 },
    ]);
    // "Used" is per target: the same text under another node does not hide it.
    expect(resolveSuggestions(chain, new Map([['p/n', new Set(['used'])]]))).toHaveLength(3);
  });

  it('is not capped', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ text: `s${i}`, up: 0 }));
    expect(resolveSuggestions(chainOf(['n', many]), noUsed)).toHaveLength(8);
    expect(resolveSuggestions(chainOf(['n', many], ['n/m', undefined]), noUsed)).toHaveLength(8);
  });
});

describe('pickCandidates', () => {
  it("is the parent's resolved list (fallback included) with the owner's origin", () => {
    const chain = chainOf(
      [
        'plan',
        [
          { text: 'A', up: 0 },
          { text: 'B', up: 0 },
        ],
      ],
      [
        'plan/x',
        [
          { text: 'X1', up: 0 },
          { text: 'B', up: 1 },
        ],
      ],
      ['plan/x/old', undefined],
    );
    expect(pickCandidates(chain, noUsed, new Set())).toEqual([
      { text: 'X1', source: 'plan/x', origin: 1 },
      { text: 'B', source: 'plan', origin: 0 },
    ]);
    expect(pickCandidates(chain.slice(0, 2), noUsed, new Set())).toEqual([
      { text: 'X1', source: 'plan/x', origin: 1 },
      { text: 'B', source: 'plan', origin: 0 },
    ]);
  });

  it('a stored empty list stops inheritance', () => {
    const chain = chainOf(['plan', [{ text: 'A', up: 0 }]], ['plan/x', []]);
    expect(pickCandidates(chain, noUsed, new Set())).toEqual([]);
    expect(pickCandidates(chainOf(['a', undefined]), noUsed, new Set())).toEqual([]);
    expect(pickCandidates([], noUsed, new Set())).toEqual([]);
  });

  it('excludes used and already asked items; not capped', () => {
    const chain = chainOf([
      'plan',
      [
        { text: 'A', up: 0 },
        { text: 'B', up: 0 },
        { text: 'C', up: 0 },
      ],
    ]);
    expect(
      pickCandidates(chain, new Map([['plan', new Set(['B'])]]), new Set([suggestionKey(' A ')])),
    ).toEqual([{ text: 'C', source: 'plan', origin: 0 }]);
    const many = Array.from({ length: 8 }, (_, i) => ({ text: `s${i}`, up: 0 }));
    expect(pickCandidates(chainOf(['n', many]), noUsed, new Set())).toHaveLength(8);
  });
});

describe('finalizeSuggestions', () => {
  const candidates = [
    { text: 'Глава 2', source: 'plan', origin: 0 },
    { text: 'Глава 3', source: 'plan', origin: 0 },
    { text: 'Deeper', source: 'plan/ch1', origin: 1 },
  ];
  const none = new Set<string>();

  it('a text equal to a candidate is a keep: `up` relative to the new node, text verbatim', () => {
    expect(
      finalizeSuggestions(['Глава 2', 'Deeper'], candidates, { depth: 2, askedKeys: none }),
    ).toEqual([
      { text: 'Глава 2', up: 2 },
      { text: 'Deeper', up: 1 },
    ]);
    // NFC / trim / wrapping quotes equal.
    const nfd = 'Глава 3'.normalize('NFD');
    expect(finalizeSuggestions([` "${nfd}" `], candidates, { depth: 1, askedKeys: none })).toEqual([
      { text: 'Глава 3', up: 1 },
    ]);
  });

  it('an edited copy of a candidate is a new own item', () => {
    expect(
      finalizeSuggestions(['Глава 2, please'], candidates, { depth: 1, askedKeys: none }),
    ).toEqual([{ text: 'Глава 2, please', up: 0 }]);
  });

  it('drops empty texts, asked questions and duplicates; own first; no cap', () => {
    const texts = [
      'Глава 2',
      '',
      '   ',
      'asked',
      'new 1',
      ' new 1 ',
      'new\n2',
      'Глава 2',
      ...Array.from({ length: 8 }, (_, i) => `more ${i}`),
    ];
    expect(
      finalizeSuggestions(texts, candidates, { depth: 1, askedKeys: new Set(['asked']) }),
    ).toEqual([
      { text: 'new 1', up: 0 },
      { text: 'new 2', up: 0 },
      ...Array.from({ length: 8 }, (_, i) => ({ text: `more ${i}`, up: 0 })),
      { text: 'Глава 2', up: 1 },
    ]);
  });

  it('a keep that would point at the node itself is dropped (defensive)', () => {
    expect(finalizeSuggestions(['Deeper'], candidates, { depth: 1, askedKeys: none })).toEqual([]);
  });

  it('everything dropped → [] (stored, empty)', () => {
    expect(finalizeSuggestions([], [], { depth: 0, askedKeys: none })).toEqual([]);
    expect(
      finalizeSuggestions(['Глава 2', ''], candidates, {
        depth: 1,
        askedKeys: new Set(['Глава 2']),
      }),
    ).toEqual([]);
  });
});
