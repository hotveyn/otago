import { describe, expect, it } from 'vitest';
import type { HierarchyNode } from '../../../web/src/api/types';
import { seedFiles } from './seed';
import { makeDemo } from './test-helpers';

const flatten = (nodes: HierarchyNode[]): string[] =>
  nodes.flatMap((node) => [node.id, ...flatten(node.children)]);

describe('seed trees', () => {
  const { demo } = makeDemo({ seed: seedFiles() });
  const trees = demo.trees.listTrees();

  it('has at least one tree, and every node.md parses', () => {
    expect(trees.length).toBeGreaterThan(0);
    const nodeFiles = Object.keys(seedFiles()).filter((path) => path.endsWith('/node.md'));
    const nodes = trees.flatMap((tree) => flatten(demo.trees.hierarchy(tree.id)));
    expect(nodes).toHaveLength(nodeFiles.length);
  });

  it('cites existing source lines and links existing attachments and files', () => {
    for (const tree of trees) {
      const sources = new Map(
        demo.trees
          .listSources(tree.id)
          .map((s) => [s.name, demo.vfs.readText(demo.trees.sourcePath(tree.id, s.name)) ?? '']),
      );
      for (const id of flatten(demo.trees.hierarchy(tree.id))) {
        const node = demo.trees.chain(tree.id, id).at(-1);
        if (!node) throw new Error(id);
        for (const [, file, start, end] of node.assistant.matchAll(
          /sources\/([\w.-]+):(\d+)(?:-(\d+))?/g,
        )) {
          const lines = sources.get(file ?? '')?.split('\n');
          expect(lines, `${id}: ${file}`).toBeDefined();
          expect(Number(end ?? start), `${id}: ${file}:${start}`).toBeLessThanOrEqual(
            lines?.length ?? 0,
          );
        }
        // web reads `[^1]:` as a footnote definition, so a reference must not precede a colon.
        expect(node.assistant, id).not.toMatch(/\S\[\^[^\]\s]+\]:/);
        const attachments = node.attachments.map((a) => a.name);
        for (const [, name] of node.assistant.matchAll(/\]\(attachments\/([^)]+)\)/g)) {
          expect(attachments, id).toContain(name);
        }
        const files = node.files.map((f) => f.name);
        for (const [, name] of node.assistant.matchAll(/`files\/([^`]+)`/g)) {
          expect(files, id).toContain(name);
        }
      }
    }
  });
});
