import matter from 'gray-matter';
import {
  parseStoredSuggestions,
  removeSuggestionsLine,
  type StoredSuggestion,
  setSuggestionsLine,
} from './suggestions.js';

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
  /** `undefined` = MISSING (key absent or not an array); an array = STORED (maybe empty). */
  suggestions?: StoredSuggestion[];
}

const USER_MARKER = '<!-- otago:user -->';
const ASSISTANT_MARKER = '<!-- otago:assistant -->';

function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  // Passing options disables gray-matter's content cache, which shares parsed objects.
  const parsed = matter(text, {});
  return { data: parsed.data, body: parsed.content };
}

function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  return matter.stringify(body, data);
}

function toIso(value: unknown, field: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`Invalid or missing "${field}" in frontmatter`);
}

function toStringField(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

/** Trim leading/trailing blank lines, keep inner formatting. */
function trimBlankLines(text: string): string {
  return text.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

export function parseTreeFile(text: string): TreeFile {
  const { data, body } = parseFrontmatter(text);
  return {
    title: toStringField(data.title),
    created: toIso(data.created, 'created'),
    instructions: trimBlankLines(body),
  };
}

export function serializeTreeFile(tree: TreeFile): string {
  const body = tree.instructions ? `${tree.instructions}\n` : '';
  return serializeFrontmatter({ title: tree.title, created: new Date(tree.created) }, body);
}

/**
 * Frontmatter of a node file. A hand-broken `suggestions:` value must not make the whole node
 * unreadable: when the YAML fails, it is parsed again without that key (the list is MISSING).
 */
function parseNodeFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  try {
    return parseFrontmatter(text);
  } catch (error) {
    const without = removeSuggestionsLine(text);
    if (without === text) throw error;
    return parseFrontmatter(without);
  }
}

export function parseNodeFile(text: string): NodeFile {
  const { data, body } = parseNodeFrontmatter(text);
  const userIndex = body.indexOf(USER_MARKER);
  const assistantIndex = body.indexOf(ASSISTANT_MARKER, userIndex === -1 ? 0 : userIndex);
  if (userIndex === -1 || assistantIndex === -1) {
    throw new Error('node.md is missing otago:user / otago:assistant markers');
  }
  const suggestions = parseStoredSuggestions(data.suggestions);
  return {
    created: toIso(data.created, 'created'),
    model: toStringField(data.model),
    user: trimBlankLines(body.slice(userIndex + USER_MARKER.length, assistantIndex)),
    assistant: trimBlankLines(body.slice(assistantIndex + ASSISTANT_MARKER.length)),
    ...(suggestions ? { suggestions } : {}),
  };
}

/**
 * node.md text. Without `suggestions` the output is exactly the pre-suggestions format; with a
 * stored list (even `[]`) the single-line `suggestions:` key is added before the closing `---`.
 */
export function serializeNodeFile(node: NodeFile): string {
  const body = `${USER_MARKER}\n${node.user}\n\n${ASSISTANT_MARKER}\n${node.assistant}\n`;
  const text = serializeFrontmatter({ created: new Date(node.created), model: node.model }, body);
  return node.suggestions ? setSuggestionsLine(text, node.suggestions) : text;
}
