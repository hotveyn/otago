import { describe, expect, it } from 'vitest';
import { parseNodeFile, parseTreeFile, serializeNodeFile, serializeTreeFile } from './format';

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
