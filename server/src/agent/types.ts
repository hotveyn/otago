import type { AttachmentStaging, ChainNode, PromptFile } from '../storage/index.js';

export type { AttachmentStaging, PromptFile };

export interface AskInput {
  /** Absolute path of the tree folder; the agent runs with it as `cwd`. */
  treeDir: string;
  instructions: string;
  chain: Pick<ChainNode, 'id' | 'user' | 'assistant' | 'attachments' | 'files'>[];
  question: string;
  /** Readable files of the current message, relative to `treeDir` (`[]` when none). */
  files: PromptFile[];
  model: string;
  signal: AbortSignal;
  /** Where the answer's attachments go (the `save_attachment` tool writes here). */
  staging: AttachmentStaging;
  /**
   * Absolute path of this answer's staging folder. Other answers' `.tmp-*` folders are hidden
   * from the agent; this one stays readable (its `files/` are the current message's files).
   */
  stagingDir: string;
}

export interface NameInput {
  /** User text, or `Attached files: <names>` for a files-only message. */
  question: string;
  /** Full final answer text; the implementation builds the prompt excerpt itself. */
  answer: string;
  model: string;
  /** Aborted on cancel/shutdown and after the naming timeout. */
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; text: string; model: string };

export interface Agent {
  /** Streams text chunks, then a single `done` event with the full answer. Throws on failure. */
  ask(input: AskInput): AsyncIterable<AgentEvent>;
  /**
   * 2–4 word node name for a question-and-answer exchange, in the answer's language
   * (a valid Unicode node name, see `toNodeName`).
   */
  name(input: NameInput): Promise<string>;
}
