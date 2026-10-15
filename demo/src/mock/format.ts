/**
 * `tree.md` / `node.md` in the same format as `server/src/storage/format.ts`, without
 * gray-matter (it needs Node's Buffer). The frontmatter is the flat `key: value` subset the
 * server writes; strings may be plain, 'single-' or "double-quoted".
 *
 * Suggestions (`suggestions: <json>`, one line) are read from the RAW value of their line and
 * written only through `setSuggestionsLine` of the server's pure module, so the format is the
 * server's byte for byte (contract `suggested-prompts/contracts/node-file.ts`).
 */
import {
  parseStoredSuggestions,
  type StoredSuggestion,
  SUGGESTIONS_KEY,
  setSuggestionsLine,
} from '../../../server/src/storage/suggestions';

export interface TreeFile {
  title: string;
  created: string;
  instructions: string;
}

export interface NodeFile {
  created: string;
  model: string;
  user: string;
  assistant: string;
  /** `undefined` = MISSING (key absent or not a JSON array); array = STORED (maybe empty). */
  suggestions?: StoredSuggestion[];
}

const USER_MARKER = '<!-- otago:user -->';
const ASSISTANT_MARKER = '<!-- otago:assistant -->';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

interface Frontmatter {
  /** Unquoted values. */
  data: Record<string, string>;
  /** Trimmed values as written (a YAML-quoted string stays quoted). */
  raw: Record<string, string>;
  body: string;
}

function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { data: {}, raw: {}, body: text };
  const data: Record<string, string> = {};
  const raw: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    raw[key] = line.slice(colon + 1).trim();
    data[key] = unquote(line.slice(colon + 1));
  }
  return { data, raw, body: match[2] ?? '' };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function serializeFrontmatter(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** A YAML scalar that reads back as `value` (JSON strings are valid YAML). */
function yamlString(value: string): string {
  return /^[\w][\w .,!?()/-]*$/u.test(value) && !/^(true|false|null|yes|no|on|off|~)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

function toIso(value: string | undefined, field: string): string {
  if (value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  throw new Error(`Invalid or missing "${field}" in frontmatter`);
}

/** Trim leading/trailing blank lines, keep inner formatting. */
function trimBlankLines(text: string): string {
  return text.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

export function parseTreeFile(text: string): TreeFile {
  const { data, body } = parseFrontmatter(text);
  return {
    title: data.title ?? '',
    created: toIso(data.created, 'created'),
    instructions: trimBlankLines(body),
  };
}

export function serializeTreeFile(tree: TreeFile): string {
  const body = tree.instructions ? `${tree.instructions}\n` : '';
  return serializeFrontmatter({ title: yamlString(tree.title), created: tree.created }, body);
}

export function parseNodeFile(text: string): NodeFile {
  const { data, raw, body } = parseFrontmatter(text);
  const userIndex = body.indexOf(USER_MARKER);
  const assistantIndex = body.indexOf(ASSISTANT_MARKER, userIndex === -1 ? 0 : userIndex);
  if (userIndex === -1 || assistantIndex === -1) {
    throw new Error('node.md is missing otago:user / otago:assistant markers');
  }
  const node: NodeFile = {
    created: toIso(data.created, 'created'),
    model: data.model ?? '',
    user: trimBlankLines(body.slice(userIndex + USER_MARKER.length, assistantIndex)),
    assistant: trimBlankLines(body.slice(assistantIndex + ASSISTANT_MARKER.length)),
  };
  // Only the write form is read: a block list, `null`, a quoted string or bad JSON → MISSING.
  const value = raw[SUGGESTIONS_KEY];
  const suggestions = value === undefined ? undefined : parseStoredSuggestions(tryJson(value));
  if (suggestions) node.suggestions = suggestions;
  return node;
}

/** Today's output; a stored list (even `[]`) adds the suggestions line before the closing `---`. */
export function serializeNodeFile(node: NodeFile): string {
  const body = `${USER_MARKER}\n${node.user}\n\n${ASSISTANT_MARKER}\n${node.assistant}\n`;
  const text = serializeFrontmatter({ created: node.created, model: yamlString(node.model) }, body);
  return Array.isArray(node.suggestions) ? setSuggestionsLine(text, node.suggestions) : text;
}

/** Later write: splice the suggestions line into a raw node.md, every other byte kept. */
export function spliceSuggestions(text: string, items: readonly StoredSuggestion[]): string {
  return setSuggestionsLine(text, items);
}
