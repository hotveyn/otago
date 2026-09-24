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
  TreeLocks,
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
  it('allows one holder per tree', async () => {
    const locks = new TreeLocks();
    const release = locks.acquire('a');
    expect(() => locks.acquire('a')).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => locks.acquire('b')()).not.toThrow();
    release();
    release();
    expect(locks.isLocked('a')).toBe(false);
    await expect(
      locks.withLock('a', async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(locks.isLocked('a')).toBe(false);
  });
});
