import { describe, expect, it } from 'vitest';
import type { ChainNode, HierarchyNode } from '../../../web/src/api/types';
import { pdfPageCount, textLineCount } from './cite';
import { seedFiles } from './seed';
import { makeDemo } from './test-helpers';

const flatten = (nodes: HierarchyNode[]): string[] =>
  nodes.flatMap((node) => [node.id, ...flatten(node.children)]);

// Mirrors contracts/citations.ts (clickable-citations): the normative reference grammar.
const REF_BOUNDARY = String.raw`(?=$|[\s)\]>\x60,;:])`;
const RANGE_BOUNDARY = String.raw`(?=$|[\s)\]>\x60.,;:])`;
const RANGE = String.raw`(?::(\d+)(?:\s*[-–]\s*(\d+))?${RANGE_BOUNDARY}|${REF_BOUNDARY})`;
const KNOWN_EXT = String.raw`\.(?:md|txt|pdf|epub|fb2(?:\.zip)?|mobi|azw3?)`;
const SOURCE_CHARS = String.raw`[\p{L}\p{M}\p{Nd}._ ,()'’+&-]`;
const USER_FILE_NAME = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const NODE_SEGMENT_SOURCE = String.raw`[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*`;
const SOURCE_REF_RE = new RegExp(
  String.raw`^(?:\./)?sources/(${SOURCE_CHARS}+?${KNOWN_EXT})${RANGE}`,
  'iu',
);
const FILE_REF_RE = new RegExp(
  String.raw`^(?:\./)?(?:(${NODE_SEGMENT_SOURCE}(?:/${NODE_SEGMENT_SOURCE})*)/)?files/(${USER_FILE_NAME})${RANGE}`,
  'u',
);
const DEFINITION_RE = /^\[\^([^\]\s]+)\]: (.*)$/gm;
const CHIP_RE = /\[\^([^\]\s]+)\](?!:)/g;
/** Printable ASCII plus tab, LF and CR: what `?raw` bundling + `writeText` keep byte-exact. */
const isAscii = (text: string) =>
  [...text].every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
  });

const isPdf = (name: string) => name.toLowerCase().endsWith('.pdf');

describe('seed trees', () => {
  const { demo } = makeDemo({ seed: seedFiles() });
  const trees = demo.trees.listTrees();

  /** Pages of a PDF or lines of a text file at a VFS path; null when missing. */
  const extentOf = (path: string, name: string): number | null => {
    const bytes = demo.vfs.readBytes(path);
    if (!bytes) return null;
    return isPdf(name) ? pdfPageCount(bytes) : textLineCount(new TextDecoder().decode(bytes));
  };

  it('has at least one tree, and every node.md parses', () => {
    expect(trees.length).toBeGreaterThan(0);
    const nodeFiles = Object.keys(seedFiles()).filter((path) => path.endsWith('/node.md'));
    const nodes = trees.flatMap((tree) => flatten(demo.trees.hierarchy(tree.id)));
    expect(nodes).toHaveLength(nodeFiles.length);
  });

  it('cites existing sources and files within their pages/lines, chips match definitions', () => {
    let pdfWithComment = 0;
    let ownFileRefs = 0;
    for (const tree of trees) {
      const sources = new Set(demo.trees.listSources(tree.id).map((s) => s.name));
      const nodes = new Map<string, ChainNode>();
      for (const id of flatten(demo.trees.hierarchy(tree.id))) {
        const node = demo.trees.chain(tree.id, id).at(-1);
        if (node) nodes.set(id, node);
      }
      for (const [id, node] of nodes) {
        const where = `${tree.id}/${id}`;
        const definitions = new Map(
          [...node.assistant.matchAll(DEFINITION_RE)].map((m) => [m[1] ?? '', m[2] ?? '']),
        );
        const chips = new Set([...node.assistant.matchAll(CHIP_RE)].map((m) => m[1] ?? ''));
        expect([...chips].sort(), where).toEqual([...definitions.keys()].sort());
        // web reads `[^1]:` as a footnote definition, so a reference must not precede a colon.
        expect(node.assistant, where).not.toMatch(/\S\[\^[^\]\s]+\]:/);

        for (const [key, text] of definitions) {
          const label = `${where} [^${key}]: ${text}`;
          const source = SOURCE_REF_RE.exec(text);
          const file = source ? null : FILE_REF_RE.exec(text);
          if (/^https?:\/\//.test(text)) continue;
          expect(source ?? file, label).not.toBeNull();
          let name: string;
          let path: string;
          let start: string | undefined;
          let end: string | undefined;
          if (source) {
            name = source[1] ?? '';
            path = demo.trees.sourcePath(tree.id, name);
            [start, end] = [source[2], source[3]];
            expect(sources, label).toContain(name);
            const comment = text.slice(source[0].length).trim();
            if (isPdf(name) && comment.startsWith('(') && comment.endsWith(')')) pdfWithComment++;
          } else if (file) {
            const nodeId = file[1] ?? id;
            name = file[2] ?? '';
            [start, end] = [file[3], file[4]];
            const owner = nodes.get(nodeId);
            expect(owner, label).toBeDefined();
            expect(
              owner?.files.map((f) => f.name),
              label,
            ).toContain(name);
            path = demo.trees.nodeFilePath(tree.id, nodeId, 'files', name);
            if (file[1] === undefined) ownFileRefs++;
          } else {
            throw new Error(label);
          }
          if (start !== undefined) {
            const extent = extentOf(path, name);
            expect(extent, label).not.toBeNull();
            expect(Number(start), label).toBeGreaterThanOrEqual(1);
            expect(Number(end ?? start), label).toBeGreaterThanOrEqual(Number(start));
            expect(Number(end ?? start), label).toBeLessThanOrEqual(extent ?? 0);
          }
        }

        const attachments = node.attachments.map((a) => a.name);
        for (const [, name] of node.assistant.matchAll(/\]\(attachments\/([^)]+)\)/g)) {
          expect(attachments, where).toContain(name);
        }
        const files = node.files.map((f) => f.name);
        for (const [, name] of node.assistant.matchAll(/`files\/([^`]+)`/g)) {
          expect(files, where).toContain(name);
        }
      }
    }
    // Showcase guard: the seed demonstrates a PDF page ref with a comment and an own-file ref.
    expect(pdfWithComment).toBeGreaterThanOrEqual(1);
    expect(ownFileRefs).toBeGreaterThanOrEqual(1);
  });

  it('bundles seed PDFs byte-exactly: ASCII only, LF line endings, at least one page', () => {
    const pdfs = Object.entries(seedFiles()).filter(([path]) => isPdf(path));
    expect(pdfs.length).toBeGreaterThanOrEqual(1);
    for (const [path, text] of pdfs) {
      expect(text.startsWith('%PDF-'), path).toBe(true);
      expect(isAscii(text), path).toBe(true);
      expect(text, path).not.toContain('\r');
      expect(pdfPageCount(new TextEncoder().encode(text)), path).toBeGreaterThanOrEqual(1);
    }
  });
});
