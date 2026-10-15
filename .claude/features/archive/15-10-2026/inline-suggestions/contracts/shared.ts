/**
 * CONTRACT SPEC (planning artifact) — feature `inline-suggestions`. Owner: server.
 *
 * Existing shapes this feature builds on, copied for reference from earlier contracts
 * (`parallel-questions`, `suggested-prompts`). UNCHANGED by this feature.
 */

/**
 * Node id = path of the node folder relative to the tree folder, `/`-joined; `""` = tree root.
 * Segments are Unicode node names, always NFC on the wire. Max 1000 UTF-16 code units.
 */
export type NodeId = string;

/** Tree id = tree folder name, ASCII kebab-case. Travels in path params. */
export type TreeId = string;

/**
 * `ChainNode` of `GET /api/trees/:tree/chain?node=`. UNCHANGED: stored suggestions are NOT part
 * of the chain payload; `assistant` is the stored answer, which never contains the block.
 */
export interface ChainNode {
  id: NodeId;
  name: string;
  created: string;
  model: string;
  user: string;
  /** Stored answer. Never contains a suggestion block (the server strips it before saving). */
  assistant: string;
  attachments: unknown[];
  files: unknown[];
}

/**
 * Question start body (`POST /api/trees/:tree/questions`). UNCHANGED. A suggestion click is a
 * plain question: `{ parentId: suggestion.target, text: suggestion.text, model, namingModel?,
 * context }`, no files.
 */
export interface StartQuestionJsonBody {
  parentId: NodeId;
  text: string;
  model?: string;
  namingModel?: string;
  context?: { kind: 'main' } | { kind: 'side'; anchor: NodeId };
}

/**
 * SSE / registry text (`chunk` events, `live.answer` in snapshots and in `GET /questions…`).
 * Shapes UNCHANGED. NEW guarantee (E7): this text never contains any part of a suggestion block
 * — from a marker line on the server withholds text until the line is known not to start the
 * final block (./block.ts). `chunk.offset` stays consistent (it counts emitted text only).
 * A retained failed entry's partial `live.answer` follows the same rule.
 */
export type StreamedTextGuarantee = never;
