/**
 * CONTRACT SPEC (planning artifact) — feature `suggested-prompts`. Owner: server.
 *
 * Existing shapes this feature builds on, copied for reference from earlier contracts
 * (`parallel-questions`, `tree-undo`). UNCHANGED by this feature.
 */

/**
 * Node id = path of the node folder relative to the tree folder, `/`-joined; `""` = tree root.
 * Segments are Unicode node names, always NFC on the wire. Max 1000 UTF-16 code units.
 */
export type NodeId = string;

/** Tree id = tree folder name, ASCII kebab-case. Travels in path params. */
export type TreeId = string;

/**
 * `ChainNode` of `GET /api/trees/:tree/chain?node=`. UNCHANGED: the stored suggestions are
 * NOT added to the chain payload (the server strips them); suggestions have their own
 * resource (./suggestions-api.ts).
 */
export interface ChainNode {
  id: NodeId;
  name: string;
  created: string;
  model: string;
  user: string;
  assistant: string;
  attachments: unknown[];
  files: unknown[];
}

/**
 * Question start body (`POST /api/trees/:tree/questions`, JSON form). UNCHANGED. A suggestion
 * click is a plain question: `{ parentId: suggestion.target, text: suggestion.text, model,
 * namingModel?, context }`, no files.
 */
export interface StartQuestionJsonBody {
  parentId: NodeId;
  text: string;
  model?: string;
  namingModel?: string;
  context?: { kind: 'main' } | { kind: 'side'; anchor: NodeId };
}
