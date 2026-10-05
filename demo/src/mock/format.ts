/**
 * `tree.md` / `node.md` in the same format as `server/src/storage/format.ts`, without
 * gray-matter (it needs Node's Buffer). The frontmatter is the flat `key: value` subset the
 * server writes; strings may be plain, 'single-' or "double-quoted".
 */

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

function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    data[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1));
  }
  return { data, body: match[2] ?? '' };
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
  const { data, body } = parseFrontmatter(text);
  const userIndex = body.indexOf(USER_MARKER);
  const assistantIndex = body.indexOf(ASSISTANT_MARKER, userIndex === -1 ? 0 : userIndex);
  if (userIndex === -1 || assistantIndex === -1) {
    throw new Error('node.md is missing otago:user / otago:assistant markers');
  }
  return {
    created: toIso(data.created, 'created'),
    model: data.model ?? '',
    user: trimBlankLines(body.slice(userIndex + USER_MARKER.length, assistantIndex)),
    assistant: trimBlankLines(body.slice(assistantIndex + ASSISTANT_MARKER.length)),
  };
}

export function serializeNodeFile(node: NodeFile): string {
  const body = `${USER_MARKER}\n${node.user}\n\n${ASSISTANT_MARKER}\n${node.assistant}\n`;
  return serializeFrontmatter({ created: node.created, model: yamlString(node.model) }, body);
}
