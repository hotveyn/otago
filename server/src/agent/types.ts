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
}

export interface NameInput {
  question: string;
  model: string;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; text: string; model: string };

export interface Agent {
  /** Streams text chunks, then a single `done` event with the full answer. Throws on failure. */
  ask(input: AskInput): AsyncIterable<AgentEvent>;
  /** 2–4 word kebab-case node name for a question. */
  name(input: NameInput): Promise<string>;
}
