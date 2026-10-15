import {
  type AttachmentInfo,
  type ChainNode,
  GENERATED_NAME_MAX_WORDS,
  nodePromptFiles,
  type PromptFile,
  toNodeName,
  type UserFileInfo,
} from '../storage/index.js';
import { collapseWhitespace, firstLine, graphemes, truncateGraphemes } from '../text.js';
import type { SuggestExchange, SuggestInput, SuggestPick } from './types.js';

export const SYSTEM_RULES = `You are a patient tutor inside Otago, a learning app. The user studies a topic through conversation.
Your working directory is the learning tree. Learning materials live in \`sources/\`.

Rules:
1. Search \`sources/\` first (Glob, Grep, Read) for every factual claim, unless the user attached files for this question: then read those first. E-books (\`.epub\`, \`.fb2\`, \`.fb2.zip\`, \`.mobi\`, \`.azw\`, \`.azw3\`) are binary: search, read and cite their extracted text \`sources/<book file>.md\` instead (e.g. \`sources/rust-book.epub.md\`).
2. Cite every fact with a Markdown footnote. A footnote starts with one reference, optionally followed by a short comment on the same line:
   - text files (\`.md\`, \`.txt\`, extracted e-book text): \`sources/<file>:<start>-<end>\` with line numbers;
   - PDFs: \`sources/<file>.pdf:<first page>-<last page>\` with the page numbers shown by Read (PDFs have no line numbers);
   - the web: the URL.
   Use the file name exactly as it is on disk, digits only in the range, one reference per footnote, nothing before the reference. Example:
   Borrowing lets you reference a value without taking ownership [^1]. The chapter opens with a summary [^2].

   [^1]: sources/the-book-ch4.md:120-134
   [^2]: sources/the-book.pdf:35-37 (chapter summary)
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

User files:
- Files the user attached are listed in \`<files>\` blocks: the current message's block right before the question, earlier messages' blocks inside the transcript. Read them with Read at the listed path (images and PDFs included). For e-books the listed path is already the extracted \`.md\` text.
- The current message's files are the primary material for the question: read them before searching \`sources/\`.
- Cite a user file like a source: \`files/<name>:<start>-<end>\` for the current message, \`<node-id>/files/<name>:<start>-<end>\` for earlier messages (page numbers for \`.pdf\`, line numbers otherwise). Never mention the temporary \`.tmp-answer-…\` path in the answer.
- User files are read-only and are not attachments: never link them with \`attachments/…\`.

Ignore folders whose name contains \`.deleted-\`; they are deleted nodes.
Folders whose name starts with \`.tmp-\` are other answers being written; ignore them, except the files listed for the current question.

Never try to modify files; the only way to create a file is \`save_attachment\`. Answer only with the final answer text in Markdown.`;

export function buildSystemPrompt(instructions: string): string {
  const trimmed = instructions.trim();
  return trimmed ? `${SYSTEM_RULES}\n\n# Tree instructions\n\n${trimmed}` : SYSTEM_RULES;
}

function filesBlock(files: PromptFile[]): string {
  const lines = files.map((file) =>
    file.bookOf
      ? `${file.path} (text extracted from ${file.bookOf}, ${file.size} bytes)`
      : `${file.path} (${file.kind}, ${file.size} bytes)`,
  );
  return `<files>\n${lines.join('\n')}\n</files>`;
}

/** Serialize previous exchanges + the new question (and its files) into one user prompt. */
export function buildUserPrompt(
  chain: Array<
    Pick<ChainNode, 'user' | 'assistant'> & {
      id?: string;
      attachments?: AttachmentInfo[];
      files?: UserFileInfo[];
    }
  >,
  question: string,
  files: PromptFile[] = [],
): string {
  const parts: string[] = [];
  if (chain.length > 0) {
    parts.push('<transcript>');
    for (const node of chain) {
      parts.push(`<user>\n${node.user}\n</user>`);
      if (node.id && node.files && node.files.length > 0) {
        parts.push(filesBlock(nodePromptFiles(node.id, node.files)));
      }
      parts.push(`<assistant>\n${node.assistant}\n</assistant>`);
      if (node.id && node.attachments && node.attachments.length > 0) {
        const lines = node.attachments.map(
          (file) => `${node.id}/attachments/${file.name} (${file.kind}, ${file.size} bytes)`,
        );
        parts.push(`<attachments>\n${lines.join('\n')}\n</attachments>`);
      }
    }
    parts.push('</transcript>', '', 'Continue the conversation above. New question:');
  }
  if (files.length > 0) parts.push(filesBlock(files));
  parts.push(question.trim());
  return parts.join('\n');
}

// Naming mirrors .claude/features/parallel-questions/contracts/naming.ts

export const NAMING_SYSTEM_PROMPT = 'You name folders. Output only the name.';

export const NAMING_PROMPT = `Name this question-and-answer exchange for a folder.
- 2 to 4 words, lowercase, joined by hyphens.
- Use the language and script of the answer's prose (ignore code, links and citations). Do not transliterate or translate.
- Letters and digits only. Reply with the name only.
Examples: English: borrowing-rules. Russian: правила-заимствования. German: regeln-der-ausleihe.`;

/** Question part of the naming prompt: first N graphemes. */
export const NAMING_QUESTION_MAX_GRAPHEMES = 500;
/** Answer excerpt cap (UTF-16 code units), cut at a word boundary, grapheme-safe. */
export const NAMING_EXCERPT_MAX_CHARS = 1_500;
/** `<answer>` content when the excerpt is empty (e.g. a code-only answer). */
export const NAMING_NO_PROSE = '(no prose)';

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** Drop fenced blocks (``` and ~~~, any info string); an unclosed fence runs to the end. */
function removeFencedBlocks(text: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = undefined;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** First `max` code units of `text`, cut at a grapheme boundary and, if possible, a space. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let kept = '';
  for (const part of graphemes(text)) {
    if (kept.length + part.length > max) break;
    kept += part;
  }
  if (text[kept.length] === ' ') return kept.trimEnd();
  const space = kept.lastIndexOf(' ');
  return (space > 0 ? kept.slice(0, space) : kept).trimEnd();
}

/**
 * Prose of an answer: fenced blocks, footnotes, images, link targets, bare URLs, inline code and
 * HTML tags removed; whitespace collapsed. `""` for a code-only answer.
 */
function cleanProse(answer: string): string {
  let text = removeFencedBlocks(answer.replace(/\r\n?/g, '\n'));
  text = text
    // Footnote definitions, then references.
    .replace(/^[ \t]*\[\^[^\]\n]+\]:.*$/gm, '')
    .replace(/\[\^[^\]\n]+\]/g, '')
    // Images entirely, links → their text.
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, '')
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    // Autolinks and bare URLs, inline code spans, HTML tags.
    .replace(/<(?:https?|ftp):\/\/[^>\s]*>/gi, '')
    .replace(/\b(?:https?|ftp):\/\/[^\s<>]+/gi, '')
    .replace(/(`+)[^`]*?\1/g, '')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, '');
  return collapseWhitespace(text);
}

/** Prose excerpt of an answer (`cleanProse`), at most `max` code units, cut at a word boundary. */
export function proseExcerpt(answer: string, max: number): string {
  return cutAtWord(cleanProse(answer), max);
}

/** Prose excerpt of an answer for the naming prompt (NAMING_EXCERPT_MAX_CHARS). */
export function namingExcerpt(answer: string): string {
  return proseExcerpt(answer, NAMING_EXCERPT_MAX_CHARS);
}

/** User prompt of the naming call: rules, the question (cut) and the answer excerpt. */
export function buildNamingPrompt(input: { question: string; answer: string }): string {
  const question = truncateGraphemes(input.question.trim(), NAMING_QUESTION_MAX_GRAPHEMES);
  const excerpt = namingExcerpt(input.answer) || NAMING_NO_PROSE;
  return `${NAMING_PROMPT}\n\n<question>\n${question}\n</question>\n<answer>\n${excerpt}\n</answer>`;
}

/** Turn a naming-model reply into a 2–4 word node name (Unicode, `toNodeName`). */
export function sanitizeNodeName(raw: string, fallback = 'node'): string {
  return toNodeName(firstLine(raw), { fallback, maxWords: GENERATED_NAME_MAX_WORDS });
}

/** Name from the question itself (its own script), used when the naming call fails. */
export function fallbackNodeName(question: string): string {
  return toNodeName(question, { maxWords: GENERATED_NAME_MAX_WORDS });
}

// Suggestions mirror .claude/features/suggested-prompts/contracts/generation.ts

export const SUGGEST_SYSTEM_PROMPT =
  "You suggest a learner's next questions in a tutoring chat. Output only JSON.";

export const SUGGEST_PROMPT = `Suggest the learner's obvious next questions after the latest answer.
- Only continuations the conversation itself sets up: a plan or list of topics stated in an answer ("chapter 1 first, then 2 and 3", "next we can cover X"), or a next step the latest answer explicitly offers. If nothing is obvious, return an empty list.
- Each suggestion is a complete, short question or request (at most 15 words) the learner would send, in the language and script of the latest answer's prose. Do not transliterate or translate.
- Do not answer the tutor's check-your-understanding questions; do not repeat questions already asked in the transcript.
- Earlier suggestions (numbered below) were offered at earlier steps. Keep one by number only if it is still a sensible next step from here; never rewrite it.
- At most 5 items in total, new ones first.
Reply with JSON only: {"suggestions":[{"text":"…"},{"keep":2}]}`;

/** Ancestors included in the suggestion prompt: the nearest N (older ones are omitted). */
export const SUGGEST_ANCESTOR_LEVELS = 4;
/** Per-question cut of the suggestion prompt, graphemes. */
export const SUGGEST_QUESTION_MAX_GRAPHEMES = 500;
/** Answer excerpt of the latest exchange: head + ` … ` + tail (code units). */
export const SUGGEST_CURRENT_ANSWER = { head: 2_000, tail: 4_000 } as const;
/** Answer excerpt of each ancestor exchange. */
export const SUGGEST_ANCESTOR_ANSWER = { head: 500, tail: 1_000 } as const;

/** Last `max` code units of `text`, cut at a grapheme boundary and, if possible, a space. */
function cutTailAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const parts = graphemes(text);
  const kept: string[] = [];
  let length = 0;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] ?? '';
    if (length + part.length > max) break;
    kept.push(part);
    length += part.length;
  }
  const tail = kept.reverse().join('');
  if (text[text.length - tail.length - 1] === ' ') return tail.trimStart();
  const space = tail.indexOf(' ');
  return (space >= 0 ? tail.slice(space + 1) : tail).trimStart();
}

/**
 * Prose of an answer (as `proseExcerpt`); when longer than `head + tail`, its first `head` and
 * last `tail` code units joined by ` … `, both cut at word boundaries (plans and "next we can
 * cover X" usually sit at the end of an answer).
 */
export function headTailExcerpt(answer: string, cap: { head: number; tail: number }): string {
  const prose = proseExcerpt(answer, Number.POSITIVE_INFINITY);
  if (prose.length <= cap.head + cap.tail) return prose;
  return `${cutAtWord(prose, cap.head)} … ${cutTailAtWord(prose, cap.tail)}`;
}

/** Display name of a node id (its last segment). */
function displayName(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

function suggestExchange(exchange: SuggestExchange, cap: { head: number; tail: number }): string {
  const question = truncateGraphemes(exchange.user.trim(), SUGGEST_QUESTION_MAX_GRAPHEMES);
  const answer = headTailExcerpt(exchange.assistant, cap) || NAMING_NO_PROSE;
  return `<user>\n${question}\n</user>\n<assistant>\n${answer}\n</assistant>`;
}

/**
 * User prompt of the suggestion call: rules, the nearest ancestors (oldest first), the latest
 * exchange and the numbered (1-based) inheritance candidates. Empty blocks are omitted.
 */
export function buildSuggestPrompt(
  input: Pick<SuggestInput, 'ancestors' | 'current' | 'candidates'>,
): string {
  const parts = [SUGGEST_PROMPT, ''];
  const ancestors = input.ancestors.slice(-SUGGEST_ANCESTOR_LEVELS);
  if (ancestors.length > 0) {
    parts.push('<transcript>');
    for (const ancestor of ancestors)
      parts.push(suggestExchange(ancestor, SUGGEST_ANCESTOR_ANSWER));
    parts.push('</transcript>');
  }
  parts.push('<latest>', suggestExchange(input.current, SUGGEST_CURRENT_ANSWER), '</latest>');
  if (input.candidates.length > 0) {
    parts.push('<earlier-suggestions>');
    for (const [index, candidate] of input.candidates.entries()) {
      parts.push(`${index + 1}. ${candidate.text} (offered at: ${displayName(candidate.source)})`);
    }
    parts.push('</earlier-suggestions>');
  }
  return parts.join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Suggestion-model reply → raw picks. Accepts an optional ```json fence, a bare array or
 * `{ "suggestions": [...] }`; items `{text}`, bare strings and `{keep: n}` (1-based, within
 * the candidates; converted to 0-based); other items are dropped. Throws on anything else.
 */
export function parseSuggestReply(raw: string, candidateCount: number): SuggestPick[] {
  let text = raw.trim();
  const fenced = /```[A-Za-z]*[ \t]*\n?([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1] ?? '';
  const object = text.indexOf('{');
  const array = text.indexOf('[');
  const start = object === -1 ? array : array === -1 ? object : Math.min(object, array);
  if (start === -1) throw new Error('Suggestion reply has no JSON');
  const end = text.lastIndexOf(text[start] === '{' ? '}' : ']');
  if (end < start) throw new Error('Suggestion reply has no complete JSON');
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  const items = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.suggestions)
      ? value.suggestions
      : undefined;
  if (!items) throw new Error('Suggestion reply has no suggestions array');
  const picks: SuggestPick[] = [];
  for (const item of items as unknown[]) {
    if (typeof item === 'string') {
      picks.push({ text: item });
    } else if (isPlainObject(item) && typeof item.text === 'string') {
      picks.push({ text: item.text });
    } else if (
      isPlainObject(item) &&
      typeof item.keep === 'number' &&
      Number.isInteger(item.keep) &&
      item.keep >= 1 &&
      item.keep <= candidateCount
    ) {
      picks.push({ keep: item.keep - 1 });
    }
  }
  return picks;
}
