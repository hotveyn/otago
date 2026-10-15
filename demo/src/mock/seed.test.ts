import { describe, expect, it } from 'vitest';
import {
  SUGGESTIONS_MARKER,
  splitSuggestionBlock,
} from '../../../server/src/storage/suggestion-block';
import {
  sanitizeSuggestionText,
  setSuggestionsLine,
  suggestionKey,
} from '../../../server/src/storage/suggestions';
import type { ChainNode, HierarchyNode } from '../../../web/src/api/types';
import { pdfPageCount, textLineCount } from './cite';
import { parseNodeFile } from './format';
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

  it('stores suggestions in the exact write form, sanitized, own first', () => {
    const nodeFiles = Object.entries(seedFiles()).filter(([path]) => path.endsWith('/node.md'));
    let withKey = 0;
    for (const [path, raw] of nodeFiles) {
      const keyLines = raw.split('\n').filter((line) => /^suggestions\s*:/.test(line));
      if (keyLines.length === 0) continue;
      withKey++;
      expect(keyLines, path).toHaveLength(1);
      const stored = parseNodeFile(raw).suggestions;
      // Not a block list, null or a string: the one-line JSON form only.
      expect(stored, path).toBeDefined();
      expect(setSuggestionsLine(raw, stored ?? []), path).toBe(raw);
      const items = stored ?? [];
      for (const item of items) expect(sanitizeSuggestionText(item.text), path).toBe(item.text);
      const firstInherited = items.findIndex((item) => item.up > 0);
      if (firstInherited !== -1) {
        expect(
          items.slice(firstInherited).every((item) => item.up > 0),
          path,
        ).toBe(true);
      }
    }
    expect(withKey).toBeGreaterThan(0);
  });

  it('every inherited seed suggestion points at an ancestor that owns the text', () => {
    for (const tree of trees) {
      for (const id of flatten(demo.trees.hierarchy(tree.id))) {
        const chain = demo.trees.suggestionChain(tree.id, id);
        const node = chain.at(-1);
        for (const item of node?.suggestions ?? []) {
          if (item.up === 0) continue;
          const where = `${tree.id}/${id}: ${item.text}`;
          expect(item.up, where).toBeLessThan(chain.length);
          const owner = chain[chain.length - 1 - item.up];
          expect(
            owner?.suggestions?.some(
              (own) => own.up === 0 && suggestionKey(own.text) === suggestionKey(item.text),
            ),
            where,
          ).toBe(true);
        }
      }
    }
  });

  it('showcases fallback, no-list, empty, deep inherited and used suggestions', () => {
    let fallback = 0;
    let none = 0;
    let empty = 0;
    let deep = 0;
    let hiddenAsUsed = 0;
    for (const tree of trees) {
      for (const id of flatten(demo.trees.hierarchy(tree.id))) {
        const stored = demo.trees.suggestionChain(tree.id, id).at(-1)?.suggestions;
        const view = demo.trees.suggestionsView(tree.id, id);
        if (stored === undefined) {
          if (view.suggestions.length === 0) none++;
          else if (view.suggestions.every((item) => item.up > 0)) fallback++;
        } else if (stored.length === 0) empty++;
        if (stored?.some((item) => item.up >= 2)) deep++;
        if (stored && view.suggestions.length < stored.length) hiddenAsUsed++;
      }
    }
    expect(fallback).toBeGreaterThanOrEqual(1);
    expect(none).toBeGreaterThanOrEqual(1);
    expect(empty).toBeGreaterThanOrEqual(1);
    expect(deep).toBeGreaterThanOrEqual(1);
    expect(hiddenAsUsed).toBeGreaterThanOrEqual(1);
    const plan = demo.trees.suggestionsView('rust-ownership', 'what-is-ownership');
    expect(plan.suggestions.map((s) => s.text)).toEqual([
      'How do slices borrow part of a String?',
      'What happens to ownership when I pass a value to a function?',
    ]);
  });

  it('a node without a list shows its nearest stored ancestor list, one level further up', () => {
    const tree = 'rust-ownership';
    const parent = demo.trees.suggestionsView(tree, 'what-is-ownership/borrowing-rules');
    const child = demo.trees.suggestionsView(
      tree,
      'what-is-ownership/borrowing-rules/mutable-references',
    );
    expect(demo.trees.suggestionChain(tree, child.node).at(-1)?.suggestions).toBeUndefined();
    expect(child.suggestions.map((item) => item.text)).toEqual([
      'How do lifetimes relate to borrowing?',
      'Can I borrow mutably inside a loop?',
      'How do slices borrow part of a String?',
      'What happens to ownership when I pass a value to a function?',
    ]);
    expect(child.suggestions).toEqual(
      parent.suggestions.map((item) => ({ ...item, up: item.up + 1 })),
    );
    expect(new Set(child.suggestions.map((item) => item.target))).toEqual(
      new Set(['what-is-ownership/borrowing-rules', 'what-is-ownership']),
    );
  });

  it('stored seed answers never contain a suggestion block', () => {
    const nodeFiles = Object.entries(seedFiles()).filter(([path]) => path.endsWith('/node.md'));
    for (const [path, raw] of nodeFiles) {
      const { assistant } = parseNodeFile(raw);
      expect(assistant, path).not.toContain(SUGGESTIONS_MARKER);
      expect(splitSuggestionBlock(assistant).items, path).toBeUndefined();
    }
  });
});
