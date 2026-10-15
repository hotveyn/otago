import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TOOLS,
  type AttachmentStaging,
  buildAskOptions,
  buildNamingPrompt,
  buildSuggestPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  DENIED_TOOLS,
  fallbackNodeName,
  headTailExcerpt,
  NAMING_EXCERPT_MAX_CHARS,
  NAMING_PROMPT,
  NAMING_SYSTEM_PROMPT,
  namingExcerpt,
  parseSuggestReply,
  proseExcerpt,
  SAVE_ATTACHMENT_TOOL_ID,
  STAGING_DENY_REASON,
  SUGGEST_ANCESTOR_ANSWER,
  SUGGEST_CURRENT_ANSWER,
  SUGGEST_PROMPT,
  SUGGEST_SYSTEM_PROMPT,
  SYSTEM_RULES,
  sanitizeNodeName,
  TRASH_DENY_REASON,
  TreeLocks,
  touchesDeletedPath,
  touchesForeignTemp,
} from '../src/agent/index.js';
import { TreeBusyError } from '../src/errors.js';

const noStaging: AttachmentStaging = {
  saveFromBytes: () => Promise.reject(new Error('not used')),
  saveFromStream: () => Promise.reject(new Error('not used')),
  saveFromUrl: () => Promise.reject(new Error('not used')),
};

describe('prompt building', () => {
  it('appends tree instructions to the system rules', () => {
    expect(buildSystemPrompt('')).toBe(SYSTEM_RULES);
    const prompt = buildSystemPrompt('  Answer in Russian.  ');
    expect(prompt.startsWith(SYSTEM_RULES)).toBe(true);
    expect(prompt).toContain('# Tree instructions\n\nAnswer in Russian.');
  });

  it('lists all six rules', () => {
    for (const phrase of [
      'sources/',
      'Cite',
      'WebSearch',
      'trust the sources',
      'Teach',
      'tree instructions',
    ]) {
      expect(SYSTEM_RULES.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });

  it('cites PDF pages and text lines, reference first', () => {
    // Contract clickable-citations/contracts/prompt.ts PROMPT_REQUIRED_PHRASES.
    for (const phrase of [
      'sources/<file>:<start>-<end>',
      'sources/<file>.pdf:<first page>-<last page>',
      'page numbers',
      'line numbers',
      'files/<name>:<start>-<end>',
      '<node-id>/files/<name>:<start>-<end>',
      'PDFs have no line numbers',
      'one reference per footnote',
      'nothing before the reference',
    ]) {
      expect(SYSTEM_RULES).toContain(phrase);
    }
  });

  it('every example footnote in the rules is machine-readable', () => {
    // Mirrors contracts/prompt.ts PROMPT_EXAMPLE_FOOTNOTE_RE: a `sources/` or `files/` ref
    // (or URL) first, then nothing or whitespace + a comment.
    const footnote =
      /^\[\^[^\]\s]+\]: (?:(?:[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}-]*\/)*(?:sources|files)\/[^\s:]+(?: [^:]+?)?\.(?:md|txt|pdf):\d+(?:-\d+)?|https?:\/\/\S+)(?:\s+\S.*)?$/u;
    const examples = SYSTEM_RULES.split('\n')
      .filter((line) => /^\s*\[\^[^\]]+\]:/.test(line))
      .map((line) => line.trim());
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const line of examples) expect(line, line).toMatch(footnote);
    // One text citation with lines, one PDF citation with pages and a comment.
    expect(examples.some((line) => /\.md:\d+-\d+$/.test(line))).toBe(true);
    expect(examples.some((line) => /\.pdf:\d+-\d+ \(.+\)$/.test(line))).toBe(true);
  });

  it('sends only the question when the chain is empty', () => {
    expect(buildUserPrompt([], '  What is borrowing? ')).toBe('What is borrowing?');
  });

  it('serializes the chain as a transcript before the new question', () => {
    const prompt = buildUserPrompt(
      [
        { user: 'Q1', assistant: 'A1' },
        { user: 'Q2', assistant: 'A2' },
      ],
      'Q3',
    );
    expect(prompt).toBe(
      [
        '<transcript>',
        '<user>\nQ1\n</user>',
        '<assistant>\nA1\n</assistant>',
        '<user>\nQ2\n</user>',
        '<assistant>\nA2\n</assistant>',
        '</transcript>',
        '',
        'Continue the conversation above. New question:',
        'Q3',
      ].join('\n'),
    );
  });

  it('configures the SDK with read-only tools in the tree folder', () => {
    const options = buildAskOptions(
      {
        treeDir: '/trees/rust',
        instructions: 'x',
        model: 'claude-sonnet-5',
        staging: noStaging,
        stagingDir: '/trees/rust/.tmp-answer-own',
      },
      new AbortController(),
    );
    expect(options.cwd).toBe('/trees/rust');
    expect(options.model).toBe('claude-sonnet-5');
    expect(options.tools).toEqual(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);
    expect(options.tools).toEqual(ALLOWED_TOOLS);
    expect(options.allowedTools).toEqual([...ALLOWED_TOOLS, SAVE_ATTACHMENT_TOOL_ID]);
    expect(SAVE_ATTACHMENT_TOOL_ID).toBe('mcp__otago__save_attachment');
    expect(options.disallowedTools).toEqual(DENIED_TOOLS);
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Write', 'Edit', 'Bash', 'NotebookEdit']),
    );
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['otago']);
    expect(options.mcpServers?.otago).toMatchObject({ type: 'sdk', name: 'otago' });
  });

  it('describes rich output in the system prompt', () => {
    for (const phrase of ['save_attachment', 'mermaid', 'attachments/', 'csv', 'svg']) {
      expect(SYSTEM_RULES).toContain(phrase);
    }
  });

  it('lists earlier attachments after the assistant block', () => {
    const prompt = buildUserPrompt(
      [
        {
          id: 'ownership',
          user: 'Q1',
          assistant: 'A1',
          attachments: [
            { name: 'chart.svg', size: 120, contentType: 'image/svg+xml', kind: 'svg' },
            { name: 'data.csv', size: 42, contentType: 'text/csv; charset=utf-8', kind: 'table' },
          ],
        },
        { id: 'ownership/borrowing', user: 'Q2', assistant: 'A2', attachments: [] },
      ],
      'Q3',
    );
    expect(prompt).toBe(
      [
        '<transcript>',
        '<user>\nQ1\n</user>',
        '<assistant>\nA1\n</assistant>',
        '<attachments>\nownership/attachments/chart.svg (svg, 120 bytes)\nownership/attachments/data.csv (table, 42 bytes)\n</attachments>',
        '<user>\nQ2\n</user>',
        '<assistant>\nA2\n</assistant>',
        '</transcript>',
        '',
        'Continue the conversation above. New question:',
        'Q3',
      ].join('\n'),
    );
  });
});

describe('user files in prompts', () => {
  const png = { name: 'diagram.png', size: 48, contentType: 'image/png', kind: 'image' as const };
  const book = {
    name: 'book.epub',
    size: 900,
    contentType: 'application/epub+zip',
    kind: 'other' as const,
    text: 'book.epub.md',
  };

  it('lists ancestor files between user and assistant blocks', () => {
    const prompt = buildUserPrompt(
      [
        {
          id: 'rust/borrowing',
          user: 'Q1',
          assistant: 'A1',
          attachments: [
            { name: 'chart.svg', size: 120, contentType: 'image/svg+xml', kind: 'svg' },
          ],
          files: [book, png],
        },
        { id: 'rust/borrowing/next', user: 'Q2', assistant: 'A2', attachments: [], files: [] },
      ],
      'Q3',
    );
    expect(prompt).toBe(
      [
        '<transcript>',
        '<user>\nQ1\n</user>',
        '<files>\nrust/borrowing/files/book.epub.md (text extracted from book.epub, 900 bytes)\nrust/borrowing/files/diagram.png (image, 48 bytes)\n</files>',
        '<assistant>\nA1\n</assistant>',
        '<attachments>\nrust/borrowing/attachments/chart.svg (svg, 120 bytes)\n</attachments>',
        '<user>\nQ2\n</user>',
        '<assistant>\nA2\n</assistant>',
        '</transcript>',
        '',
        'Continue the conversation above. New question:',
        'Q3',
      ].join('\n'),
    );
  });

  it('puts the current files right before the question', () => {
    const files = [
      {
        path: 'rust/.tmp-answer-x/files/shot.png',
        name: 'shot.png',
        kind: 'image' as const,
        size: 5,
      },
    ];
    expect(buildUserPrompt([], ' Q ', files)).toBe(
      '<files>\nrust/.tmp-answer-x/files/shot.png (image, 5 bytes)\n</files>\nQ',
    );
    const withChain = buildUserPrompt([{ user: 'Q1', assistant: 'A1' }], 'Q2', files);
    expect(
      withChain.endsWith(
        'Continue the conversation above. New question:\n<files>\nrust/.tmp-answer-x/files/shot.png (image, 5 bytes)\n</files>\nQ2',
      ),
    ).toBe(true);
    expect(buildUserPrompt([], 'Q', [])).toBe('Q');
  });

  it('explains user files in the system rules', () => {
    for (const phrase of [
      '<files>',
      'files/<name>',
      '<node-id>/files/',
      '.tmp-answer-',
      'attachments/…',
      'files/<name>:<start>-<end>',
      '<node-id>/files/<name>:<start>-<end>',
      'page numbers for `.pdf`, line numbers otherwise',
    ]) {
      expect(SYSTEM_RULES).toContain(phrase);
    }
  });
});

describe('node name sanitizing', () => {
  it.each([
    ['borrowing-rules', 'borrowing-rules'],
    ['Borrowing Rules', 'borrowing-rules'],
    ['  "move_semantics."  ', 'move-semantics'],
    ['what is the borrow checker exactly', 'what-is-the-borrow'],
    ['lifetimes\nExplanation: ...', 'lifetimes'],
    ['\n\n  правила-заимствования\nПояснение', 'правила-заимствования'],
    ['../../etc/passwd', 'etc-passwd'],
    ['Привет', 'привет'],
    ['Café crème', 'café-crème'],
    ['Regeln der Ausleihe', 'regeln-der-ausleihe'],
    ['所有権 と 借用', '所有権-と-借用'],
    ['👩‍👩‍👧 !!!', 'node'],
    ['', 'node'],
  ])('%j → %s', (raw, expected) => {
    expect(sanitizeNodeName(raw)).toBe(expected);
  });

  it('uses the given fallback', () => {
    expect(sanitizeNodeName('!!!', 'fallback')).toBe('fallback');
  });

  it('falls back to the question text, in its own script', () => {
    expect(fallbackNodeName('What is ownership in Rust?')).toBe('what-is-ownership-in');
    expect(fallbackNodeName('Что такое владение в Rust?')).toBe('что-такое-владение-в');
    expect(fallbackNodeName('Attached files: diagram.png')).toBe('attached-files-diagram-png');
    expect(fallbackNodeName('???')).toBe('node');
  });
});

describe('naming prompt', () => {
  it('keeps prose and drops code, links, footnotes, URLs and HTML', () => {
    const answer = [
      'Borrowing lets you **reference** a value [^1]. The cover says so [^2].',
      '',
      '```rust',
      'let r = &x;',
      '```',
      '',
      '~~~mermaid',
      'graph TD; A-->B',
      '~~~',
      '',
      'See [the book](https://doc.rust-lang.org/book/) and ![diagram](attachments/d.svg).',
      'Use `&mut` for <b>mutable</b> borrows: https://example.com/x <https://example.com/y>',
      '',
      '[^1]: sources/the-book-ch4.md:120-134',
      '[^2]: sources/a.pdf:1-4 (cover)',
    ].join('\n');
    expect(namingExcerpt(answer)).toBe(
      'Borrowing lets you **reference** a value . The cover says so . See the book and . Use for mutable borrows:',
    );
    expect(namingExcerpt(answer)).not.toContain('(cover)');
  });

  it('drops an unclosed fence to the end and returns "" for a code-only answer', () => {
    expect(namingExcerpt('Intro\n```js\nconst a = 1;\nno end')).toBe('Intro');
    expect(namingExcerpt('```python\nprint(1)\n```')).toBe('');
    expect(namingExcerpt('````md\n```\ninner\n```\n````\nAfter')).toBe('After');
  });

  it('cuts long prose at a word boundary, grapheme-safe', () => {
    const words = Array.from({ length: 400 }, (_, i) => `слово${i}`).join(' ');
    const excerpt = namingExcerpt(words);
    expect(excerpt.length).toBeLessThanOrEqual(NAMING_EXCERPT_MAX_CHARS);
    expect(words.startsWith(excerpt)).toBe(true);
    expect(words[excerpt.length]).toBe(' ');
    // No spaces at all (e.g. CJK): a grapheme-safe hard cut.
    const cjk = '借'.repeat(2000);
    expect(namingExcerpt(cjk)).toBe('借'.repeat(NAMING_EXCERPT_MAX_CHARS));
    const emoji = '👍'.repeat(1000);
    const cut = namingExcerpt(emoji);
    expect(cut.length).toBe(NAMING_EXCERPT_MAX_CHARS);
    expect([...cut].every((c) => c === '👍')).toBe(true);
  });

  it('labels its examples by language and wraps question and answer', () => {
    expect(NAMING_SYSTEM_PROMPT).toBe('You name folders. Output only the name.');
    for (const phrase of [
      'English: borrowing-rules',
      'Russian: правила-заимствования',
      'German: regeln-der-ausleihe',
      "language and script of the answer's prose",
      'Do not transliterate or translate',
    ]) {
      expect(NAMING_PROMPT).toContain(phrase);
    }
    const prompt = buildNamingPrompt({
      question: '  Что такое заимствование?  ',
      answer: 'Это ссылка.',
    });
    expect(prompt).toBe(
      `${NAMING_PROMPT}\n\n<question>\nЧто такое заимствование?\n</question>\n<answer>\nЭто ссылка.\n</answer>`,
    );
  });

  it('cuts the question at 500 graphemes and marks a code-only answer', () => {
    const question = 'é'.normalize('NFD').repeat(600);
    const prompt = buildNamingPrompt({ question, answer: '```\ncode\n```' });
    const inside = prompt.split('<question>\n')[1]?.split('\n</question>')[0] ?? '';
    expect(inside).toBe('é'.normalize('NFD').repeat(500));
    expect(prompt).toContain('<answer>\n(no prose)\n</answer>');
  });
});

describe('suggestion prompt', () => {
  const words = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');

  it('proseExcerpt is the naming excerpt with another cap', () => {
    const answer = 'Text [^1] with `code`.\n\n```js\nx\n```\n\n[^1]: sources/a.md:1-2';
    expect(proseExcerpt(answer, 1_500)).toBe(namingExcerpt(answer));
    expect(proseExcerpt(words('w', 50), 12)).toBe('w0 w1 w2 w3');
  });

  it('head/tail excerpt keeps the end of a long answer', () => {
    const short = 'Short answer.';
    expect(headTailExcerpt(short, SUGGEST_CURRENT_ANSWER)).toBe(short);
    const answer = `${words('начало', 800)}\n\nДалее разберём главу 2 и главу 3.`;
    const excerpt = headTailExcerpt(answer, { head: 100, tail: 200 });
    const [head, tail] = excerpt.split(' … ');
    expect(head?.length).toBeLessThanOrEqual(100);
    expect(tail?.length).toBeLessThanOrEqual(200);
    expect(answer.startsWith(head ?? '')).toBe(true);
    expect(tail?.endsWith('Далее разберём главу 2 и главу 3.')).toBe(true);
    // Word boundaries on both sides.
    expect(tail?.startsWith('начало')).toBe(true);
    expect(answer.includes(` ${tail?.split(' ')[0]} `)).toBe(true);
    // No spaces: grapheme-safe hard cuts.
    const emoji = headTailExcerpt('👍'.repeat(500), { head: 10, tail: 10 });
    expect(emoji).toBe(`${'👍'.repeat(5)} … ${'👍'.repeat(5)}`);
  });

  it('has the rules, the latest exchange and no empty blocks', () => {
    expect(SUGGEST_SYSTEM_PROMPT).toContain('Output only JSON');
    for (const phrase of [
      'If nothing is obvious, return an empty list',
      "language and script of the latest answer's prose",
      'never rewrite it',
      'At most 5 items',
      '{"suggestions":[{"text":"…"},{"keep":2}]}',
    ]) {
      expect(SUGGEST_PROMPT).toContain(phrase);
    }
    const prompt = buildSuggestPrompt({
      ancestors: [],
      current: { user: '  Что такое заимствование?  ', assistant: '```\ncode\n```' },
      candidates: [],
    });
    expect(prompt).toBe(
      `${SUGGEST_PROMPT}\n\n<latest>\n<user>\nЧто такое заимствование?\n</user>\n<assistant>\n(no prose)\n</assistant>\n</latest>`,
    );
    expect(prompt).not.toContain('<transcript>');
    expect(prompt).not.toContain('<earlier-suggestions>');
  });

  it('includes the nearest 4 ancestors oldest first and numbers candidates from 1', () => {
    const ancestors = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      user: `question ${i}`,
      assistant: i === 5 ? `${words('x', 600)} tail-marker` : `answer ${i}`,
    }));
    const prompt = buildSuggestPrompt({
      ancestors,
      current: { user: 'Глава 1', assistant: 'Глава 1 — это начало.' },
      candidates: [
        { text: 'Глава 2', source: 'план', origin: 0 },
        { text: 'Deeper', source: 'план/глава-1', origin: 1 },
      ],
    });
    expect(prompt).not.toContain('question 0');
    expect(prompt).not.toContain('question 1');
    const order = ['question 2', 'question 3', 'question 4', 'question 5', '<latest>'].map((part) =>
      prompt.indexOf(part),
    );
    expect(order.every((index, i) => index > (order[i - 1] ?? -1))).toBe(true);
    // Ancestor answers get the short head/tail cut.
    const last = prompt
      .split('<user>\nquestion 5\n</user>\n<assistant>\n')[1]
      ?.split('\n</assistant>')[0];
    expect(last?.length).toBeLessThanOrEqual(
      SUGGEST_ANCESTOR_ANSWER.head + SUGGEST_ANCESTOR_ANSWER.tail + 3,
    );
    expect(last?.endsWith('tail-marker')).toBe(true);
    expect(prompt).toContain(
      '<earlier-suggestions>\n1. Глава 2 (offered at: план)\n2. Deeper (offered at: глава-1)\n</earlier-suggestions>',
    );
  });
});

describe('parseSuggestReply', () => {
  it('reads a fenced reply, a bare array and {suggestions}', () => {
    expect(parseSuggestReply('```json\n{"suggestions":[{"text":"a"},{"keep":2}]}\n```', 2)).toEqual(
      [{ text: 'a' }, { keep: 1 }],
    );
    expect(parseSuggestReply('Here you go: [{"text":"a"}, "b"] done', 0)).toEqual([
      { text: 'a' },
      { text: 'b' },
    ]);
    expect(parseSuggestReply('{"suggestions":[]}', 0)).toEqual([]);
    expect(parseSuggestReply('```\n[]\n```', 0)).toEqual([]);
  });

  it('drops out-of-range keeps and bad items', () => {
    expect(
      parseSuggestReply(
        '{"suggestions":[{"keep":0},{"keep":3},{"keep":1.5},{"keep":"1"},{"keep":1},{"text":5},null,7,{"text":"ok"}]}',
        2,
      ),
    ).toEqual([{ keep: 0 }, { text: 'ok' }]);
  });

  it('throws on garbage or without an array', () => {
    expect(() => parseSuggestReply('no json here', 0)).toThrow();
    expect(() => parseSuggestReply('{"suggestions": [', 0)).toThrow();
    expect(() => parseSuggestReply('{}', 0)).toThrow();
    expect(() => parseSuggestReply('{"suggestions":"a"}', 0)).toThrow();
    expect(() => parseSuggestReply('"just a string"', 0)).toThrow();
  });
});

describe('TreeLocks', () => {
  const conflict = (code: string) => expect.objectContaining({ statusCode: 409, code });

  it('allows many shared holders per tree', () => {
    const locks = new TreeLocks();
    locks.acquireShared('a');
    locks.acquireShared('a');
    locks.acquireShared('a');
    expect(locks.status('a')).toEqual({ shared: 3, exclusive: false });
    expect(locks.isLocked('a')).toBe(true);
  });

  it('rejects exclusive while shared is held', () => {
    const locks = new TreeLocks();
    locks.acquireShared('a');
    expect(() => locks.acquireExclusive('a')).toThrow(conflict('tree_busy_streaming'));
    expect(() => locks.acquireExclusive('a')).toThrow(
      'Tree "a" is busy: an answer is still streaming. Try again when it finishes.',
    );
    expect(locks.status('a')).toEqual({ shared: 1, exclusive: false });
  });

  it('rejects shared and exclusive while exclusive is held', () => {
    const locks = new TreeLocks();
    locks.acquireExclusive('a');
    expect(() => locks.acquireShared('a')).toThrow(conflict('tree_busy_structural'));
    expect(() => locks.acquireExclusive('a')).toThrow(conflict('tree_busy_structural'));
    expect(() => locks.acquireShared('a')).toThrow(
      'Tree "a" is busy: nodes are being moved, renamed or deleted. Try again in a moment.',
    );
    expect(locks.status('a')).toEqual({ shared: 0, exclusive: true });
  });

  it('isolates trees', () => {
    const locks = new TreeLocks();
    locks.acquireExclusive('a');
    locks.acquireShared('c');
    expect(locks.isLocked('b')).toBe(false);
    expect(() => locks.acquireShared('b')()).not.toThrow();
    expect(() => locks.acquireExclusive('b')()).not.toThrow();
    expect(locks.status('b')).toEqual({ shared: 0, exclusive: false });
  });

  it('records shared holders (anonymous ones get unique ids)', () => {
    const locks = new TreeLocks();
    const releaseA = locks.acquireShared('a', 'q1');
    const releaseB = locks.acquireShared('a', 'q2');
    const anonymous = locks.acquireShared('a');
    expect(locks.holders('a')).toEqual(['q1', 'q2', expect.stringMatching(/^anon:\d+$/)]);
    expect(locks.status('a')).toEqual({ shared: 3, exclusive: false });
    releaseA();
    releaseA();
    expect(locks.holders('a')).toEqual(['q2', expect.stringMatching(/^anon:/)]);
    anonymous();
    expect(locks.holders('a')).toEqual(['q2']);
    // The same holder twice is counted twice and listed once.
    const again = locks.acquireShared('a', 'q2');
    expect(locks.holders('a')).toEqual(['q2']);
    releaseB();
    expect(locks.holders('a')).toEqual(['q2']);
    again();
    expect(locks.holders('a')).toEqual([]);
    expect(locks.isLocked('a')).toBe(false);
  });

  it('throws TreeBusyError with the tree id and a snapshot of the holders', () => {
    const locks = new TreeLocks();
    const release = locks.acquireShared('a', 'q1');
    let error: unknown;
    try {
      locks.acquireExclusive('a');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TreeBusyError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'tree_busy_streaming',
      treeId: 'a',
      holders: ['q1'],
    });
    release();
    expect((error as TreeBusyError).holders).toEqual(['q1']);
    const exclusive = locks.acquireExclusive('a');
    expect(() => locks.acquireShared('a', 'q2')).toThrow(TreeBusyError);
    expect(locks.holders('a')).toEqual([]);
    exclusive();
  });

  it('has idempotent releases', () => {
    const locks = new TreeLocks();
    const first = locks.acquireShared('a');
    const second = locks.acquireShared('a');
    first();
    first();
    expect(locks.status('a')).toEqual({ shared: 1, exclusive: false });
    second();
    expect(locks.isLocked('a')).toBe(false);
    const exclusive = locks.acquireExclusive('a');
    exclusive();
    exclusive();
    expect(locks.isLocked('a')).toBe(false);
    const shared = locks.acquireShared('a');
    exclusive();
    expect(locks.status('a')).toEqual({ shared: 1, exclusive: false });
    shared();
  });

  it('releases on throw in withShared / withExclusive', async () => {
    const locks = new TreeLocks();
    await expect(
      locks.withExclusive('a', async () => {
        expect(locks.status('a').exclusive).toBe(true);
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(locks.isLocked('a')).toBe(false);
    await expect(
      locks.withShared('a', async () => {
        expect(locks.status('a').shared).toBe(1);
        throw new Error('y');
      }),
    ).rejects.toThrow('y');
    expect(locks.isLocked('a')).toBe(false);
    expect(await locks.withShared('a', async () => 42)).toBe(42);
  });
});

describe('trash guard', () => {
  const trash = 'ownership/borrowing.deleted-1759000000000';

  it('detects Read/Grep/Glob inputs touching soft-deleted folders', () => {
    expect(touchesDeletedPath('Read', { file_path: `${trash}/node.md` })).toBe(true);
    expect(touchesDeletedPath('Read', { file_path: `/trees/rust/${trash}/node.md` })).toBe(true);
    expect(touchesDeletedPath('Grep', { pattern: 'x', path: trash })).toBe(true);
    expect(touchesDeletedPath('Grep', { pattern: 'x', glob: '*.deleted-*/**' })).toBe(true);
    expect(touchesDeletedPath('Glob', { pattern: '**/*.deleted-*/node.md' })).toBe(true);
    expect(touchesDeletedPath('Glob', { pattern: '*.md', path: trash })).toBe(true);
  });

  it('allows normal paths and other tools', () => {
    expect(touchesDeletedPath('Read', { file_path: 'sources/book.md' })).toBe(false);
    expect(touchesDeletedPath('Grep', { pattern: '.deleted-', path: 'sources' })).toBe(false);
    expect(touchesDeletedPath('Glob', { pattern: '**/*.md' })).toBe(false);
    expect(touchesDeletedPath('WebFetch', { url: `https://x/${trash}` })).toBe(false);
    expect(touchesDeletedPath('Read', null)).toBe(false);
  });

  it('buildAskOptions wires the deny rule and the PreToolUse hook', async () => {
    const options = buildAskOptions(
      {
        treeDir: '/trees/rust',
        instructions: '',
        model: 'm',
        staging: noStaging,
        stagingDir: '/trees/rust/.tmp-answer-own',
      },
      new AbortController(),
    );
    const settings = options.settings as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(['Read(**/*.deleted-*/**)']);
    const matchers = options.hooks?.PreToolUse ?? [];
    expect(matchers).toHaveLength(1);
    expect(matchers[0]?.matcher).toBe('Read|Grep|Glob');
    const hook = matchers[0]?.hooks[0];
    if (!hook) throw new Error('hook missing');
    const base = { session_id: 's', transcript_path: 't', cwd: '/trees/rust' };
    const signal = new AbortController().signal;
    const denied = await hook(
      {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: `${trash}/node.md` },
        tool_use_id: 'u1',
      },
      'u1',
      { signal },
    );
    expect(denied).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: TRASH_DENY_REASON,
      },
    });
    const allowed = await hook(
      {
        ...base,
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'sources/book.md' },
        tool_use_id: 'u2',
      },
      'u2',
      { signal },
    );
    expect(allowed).toEqual({});
  });

  it('the system prompt tells the agent to ignore deleted folders', () => {
    expect(SYSTEM_RULES).toContain('Ignore folders whose name contains `.deleted-`');
  });
});

describe('staging guard (parallel answers)', () => {
  const own = '.tmp-answer-own';
  const other = '.tmp-answer-other';

  it('denies other answers’ staging folders in Read/Grep/Glob', () => {
    expect(touchesForeignTemp('Read', { file_path: `${other}/files/a.png` }, own)).toBe(true);
    expect(touchesForeignTemp('Read', { file_path: `/trees/rust/x/${other}/a` }, own)).toBe(true);
    expect(touchesForeignTemp('Grep', { pattern: 'x', path: `x/${other}` }, own)).toBe(true);
    expect(touchesForeignTemp('Grep', { pattern: 'x', glob: '**/.tmp-*/**' }, own)).toBe(true);
    expect(touchesForeignTemp('Glob', { pattern: '**/.tmp-answer-*/files/*' }, own)).toBe(true);
    expect(touchesForeignTemp('Glob', { pattern: '*.md', path: other }, own)).toBe(true);
  });

  it('allows the own staging folder (relative and absolute) and ignores Grep patterns', () => {
    expect(touchesForeignTemp('Read', { file_path: `${own}/files/a.png` }, own)).toBe(false);
    expect(touchesForeignTemp('Read', { file_path: `/trees/rust/x/${own}/files/a` }, own)).toBe(
      false,
    );
    expect(touchesForeignTemp('Grep', { pattern: '.tmp-answer-other', path: 'sources' }, own)).toBe(
      false,
    );
    expect(touchesForeignTemp('Glob', { pattern: '**/*.md' }, own)).toBe(false);
    expect(touchesForeignTemp('WebFetch', { url: `https://x/${other}` }, own)).toBe(false);
    expect(touchesForeignTemp('Read', null, own)).toBe(false);
  });

  it('the PreToolUse hook denies foreign staging, deleted folders first', async () => {
    const options = buildAskOptions(
      {
        treeDir: '/trees/rust',
        instructions: '',
        model: 'm',
        staging: noStaging,
        stagingDir: `/trees/rust/a/${own}`,
      },
      new AbortController(),
    );
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback;
    const call = (tool_input: unknown) =>
      hook(
        {
          session_id: 's',
          transcript_path: 't',
          cwd: '/trees/rust',
          hook_event_name: 'PreToolUse',
          tool_name: 'Read',
          tool_input,
          tool_use_id: 'u',
        },
        'u',
        { signal: new AbortController().signal },
      );
    const reason = async (tool_input: unknown) =>
      ((await call(tool_input)) as { hookSpecificOutput?: { permissionDecisionReason?: string } })
        .hookSpecificOutput?.permissionDecisionReason;
    expect(await reason({ file_path: `a/${other}/files/x.png` })).toBe(STAGING_DENY_REASON);
    expect(await reason({ file_path: `a/${own}/files/x.png` })).toBeUndefined();
    expect(await reason({ file_path: `x.deleted-1759000000000/${other}/n.md` })).toBe(
      TRASH_DENY_REASON,
    );
  });

  it('the system prompt tells the agent to ignore other answers’ folders', () => {
    expect(SYSTEM_RULES).toContain(
      'Folders whose name starts with `.tmp-` are other answers being written; ignore them, except the files listed for the current question.',
    );
  });
});
