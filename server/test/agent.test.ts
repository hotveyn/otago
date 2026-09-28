import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TOOLS,
  type AttachmentStaging,
  buildAskOptions,
  buildSystemPrompt,
  buildUserPrompt,
  DENIED_TOOLS,
  fallbackNodeName,
  SAVE_ATTACHMENT_TOOL_ID,
  SYSTEM_RULES,
  sanitizeNodeName,
  TRASH_DENY_REASON,
  TreeLocks,
  touchesDeletedPath,
} from '../src/agent/index.js';

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
      { treeDir: '/trees/rust', instructions: 'x', model: 'claude-sonnet-5', staging: noStaging },
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
    ['../../etc/passwd', 'etc-passwd'],
    ['Привет', 'node'],
    ['', 'node'],
  ])('%j → %s', (raw, expected) => {
    expect(sanitizeNodeName(raw)).toBe(expected);
  });

  it('falls back to the question text', () => {
    expect(fallbackNodeName('What is ownership in Rust?')).toBe('what-is-ownership-in');
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
      { treeDir: '/trees/rust', instructions: '', model: 'm', staging: noStaging },
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
