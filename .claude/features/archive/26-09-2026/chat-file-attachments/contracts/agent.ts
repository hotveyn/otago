/**
 * CONTRACT SPEC (planning artifact) — feature `chat-file-attachments`.
 * Server-internal: how user files reach the agent. Recorded here so the full shape lives in one
 * place; the web never sees this.
 *
 * Visibility rule: the agent sees the files of the CURRENT message and of every ANCESTOR node in
 * the chain (root → parent). Siblings / other branches are never listed (they are not in the
 * chain). Moving a subtree keeps access (chain-based); a node moved out of the owner's subtree
 * loses it. The agent runs with `cwd = treeDir` and only Read/Grep/Glob, so listing = access path.
 */

/** One readable file line in the prompt. Paths are RELATIVE to the tree folder (agent cwd). */
export interface PromptFile {
  /** Path the agent should Read: the file itself, or for e-books the `.md` companion. */
  path: string;
  /** Stored name (what the answer should mention). */
  name: string;
  kind: 'image' | 'svg' | 'table' | 'text' | 'pdf' | 'other';
  size: number;
  /** E-books: the original book file name the companion was extracted from. */
  bookOf?: string;
}

/**
 * Prompt layout (`buildUserPrompt`):
 *
 *   <transcript>
 *   <user>
 *   …
 *   </user>
 *   <files>                                   ← NEW, only if the node has user files
 *   rust/borrowing/files/diagram.png (image, 48213 bytes)
 *   rust/borrowing/files/book.epub.md (text extracted from book.epub, 912345 bytes)
 *   </files>
 *   <assistant>
 *   …
 *   </assistant>
 *   <attachments>                             ← unchanged (agent files)
 *   …
 *   </attachments>
 *   </transcript>
 *
 *   Continue the conversation above. New question:     (only when the chain is non-empty)
 *   <files>                                   ← NEW, only if the current message has files
 *   rust/.tmp-answer-AbC123/files/screenshot.png (image, 1234 bytes)
 *   </files>
 *   <question text, or EMPTY_TEXT_QUESTION>
 *
 * Current-message paths point into the staging folder (the node does not exist yet); the system
 * rules tell the agent to read them there but refer to them in the answer as `files/<name>`.
 */
export const PROMPT_FILES_TAG = 'files';

/**
 * SYSTEM_RULES additions (wording is the implementer's, semantics fixed):
 * - Files the user attached are listed in `<files>` blocks: the current message's block right
 *   before the question, earlier messages' blocks inside the transcript. Read them with Read at
 *   the listed path (images and PDFs included). For e-books, the listed path is already the
 *   extracted `.md` text.
 * - The current message's files are the primary material for the question: read them before
 *   searching `sources/`.
 * - Cite a user file like a source: current message `files/<name>:<start>-<end>`, earlier
 *   messages `<node-id>/files/<name>:<start>-<end>`. Never mention the temporary
 *   `.tmp-answer-…` path in the answer.
 * - User files are read-only and are not `attachments/`; do not link them with `attachments/…`.
 */
export type SystemRulesUserFiles = never;
