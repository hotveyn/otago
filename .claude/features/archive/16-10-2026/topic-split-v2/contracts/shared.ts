/**
 * CONTRACT SPEC (planning artifact) — feature `topic-split-v2`. Owner: server.
 * Existing shapes this feature builds on (from `parallel-questions` / `inline-suggestions`).
 * UNCHANGED by this feature; restated because the "whole" target may be the tree root.
 */

/**
 * Node id = path of the node folder relative to the tree folder, `/`-joined; `""` = tree root.
 * Segments are Unicode node names, always NFC on the wire. Max 1000 UTF-16 code units.
 * `""` is a valid `parentId` of a question (a new top-level node) but not a valid `node` of
 * `GET …/suggestions` (the root has no suggestions; 400 unchanged).
 */
export type NodeId = string;

/** Tree id = tree folder name, ASCII kebab-case. */
export type TreeId = string;

/**
 * Question start body (`POST /api/trees/:tree/questions`). UNCHANGED. A suggestion click — the
 * "whole" item included — is a plain question:
 *   `{ parentId: suggestion.target, text: suggestion.text, model, namingModel?, context }`,
 * no files. For "whole" on a top-level map node `parentId` is `""` (accepted today: a new
 * top-level node). `context` rule UNCHANGED (`validateContext`): a side context's `anchor` must be
 * `parentId` or one of its ancestors. A side panel's head lies strictly inside its anchor's
 * subtree, so the parent of a map node shown in a side panel is the anchor or below it, and the
 * send is valid with the panel's own context.
 */
export interface StartQuestionJsonBody {
  parentId: NodeId;
  text: string;
  model?: string;
  namingModel?: string;
  context?: { kind: 'main' } | { kind: 'side'; anchor: NodeId };
}

/**
 * Streaming guarantee. UNCHANGED, restated: `chunk` events, `live.answer` and the stored
 * `assistant` never contain the suggestion block, the "whole" item line included (the item is
 * an ordinary block line, withheld by the same filter).
 */
export type StreamingGuarantee = never;
