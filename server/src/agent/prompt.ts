import type { AttachmentInfo, ChainNode } from '../storage/index.js';

export const SYSTEM_RULES = `You are a patient tutor inside Otago, a learning app. The user studies a topic through conversation.
Your working directory is the learning tree. Learning materials live in \`sources/\`.

Rules:
1. Search \`sources/\` first (Glob, Grep, Read) for every factual claim. E-books (\`.epub\`, \`.fb2\`, \`.fb2.zip\`, \`.mobi\`, \`.azw\`, \`.azw3\`) are binary: search, read and cite their extracted text \`sources/<book file>.md\` instead (e.g. \`sources/rust-book.epub.md\`).
2. Cite every fact with a Markdown footnote. A footnote is either \`sources/<file>:<start>-<end>\` (line numbers) or a URL. Example:
   Borrowing lets you reference a value without taking ownership [^1].

   [^1]: sources/the-book-ch4.md:120-134
3. If \`sources/\` is empty or has nothing relevant, use WebSearch / WebFetch and say that the answer comes from the web.
4. If sources conflict with the web, trust the sources and flag the conflict explicitly.
5. Teach: explain, give examples, and check understanding with a short question at the end.
6. Follow the tree instructions below.

Rich output:
- Diagrams: use \`\`\`mermaid fenced code blocks.
- Small tables: GFM Markdown tables, or \`\`\`csv / \`\`\`tsv fenced blocks.
- Files (SVG illustrations, datasets, documents, images): call \`save_attachment\` with \`content\` + \`encoding\`, or with \`url\`. Reference the file by the \`path\` the tool returns: \`![alt](attachments/<name>)\` for images and SVG, \`[label](attachments/<name>)\` for other files. Always use the name returned by the tool.
- Never put SVG inline in the answer; save it as a \`.svg\` attachment.
- Attachments of earlier answers are listed in the transcript and can be read with Read at \`<node-id>/attachments/<name>\`. Do not link to them with \`attachments/…\` (that prefix means the current answer); save a new version instead.

Never try to modify files; the only way to create a file is \`save_attachment\`. Answer only with the final answer text in Markdown.`;

export function buildSystemPrompt(instructions: string): string {
  const trimmed = instructions.trim();
  return trimmed ? `${SYSTEM_RULES}\n\n# Tree instructions\n\n${trimmed}` : SYSTEM_RULES;
}

/** Serialize previous exchanges + the new question into one user prompt. */
export function buildUserPrompt(
  chain: Array<
    Pick<ChainNode, 'user' | 'assistant'> & { id?: string; attachments?: AttachmentInfo[] }
  >,
  question: string,
): string {
  const parts: string[] = [];
  if (chain.length > 0) {
    parts.push('<transcript>');
    for (const node of chain) {
      parts.push(`<user>\n${node.user}\n</user>`, `<assistant>\n${node.assistant}\n</assistant>`);
      if (node.id && node.attachments && node.attachments.length > 0) {
        const lines = node.attachments.map(
          (file) => `${node.id}/attachments/${file.name} (${file.kind}, ${file.size} bytes)`,
        );
        parts.push(`<attachments>\n${lines.join('\n')}\n</attachments>`);
      }
    }
    parts.push('</transcript>', '', 'Continue the conversation above. New question:');
  }
  parts.push(question.trim());
  return parts.join('\n');
}

export const NAMING_PROMPT = `Name this question for a folder. Reply with 2-4 lowercase English words separated by hyphens, nothing else. Example: borrowing-rules`;

/** Turn a model reply into a 2–4 word kebab-case name. */
export function sanitizeNodeName(raw: string, fallback = 'node'): string {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  const words = firstLine
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  const name = words.join('-').slice(0, 60).replace(/-+$/, '');
  return name || fallback;
}

/** Name from the question itself, used when the naming call fails. */
export function fallbackNodeName(question: string): string {
  return sanitizeNodeName(question, 'node');
}
