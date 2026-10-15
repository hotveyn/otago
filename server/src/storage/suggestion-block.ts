// The suggestion block the answering agent may append to its answer: grammar, the streaming
// filter that withholds it and the split at save. Mirrors
// .claude/features/inline-suggestions/contracts/block.ts.
// Pure and Node-free (imports nothing): demo/src/mock/ imports this file as-is. One line state
// machine serves both the filter and the split, so they never disagree on the same text.

/** Canonical marker line (what the prompt asks for and what `suggestionBlock` writes). */
export const SUGGESTIONS_MARKER = '<!-- otago:suggestions -->';

/** A marker line (case-sensitive; a trailing `\r` is ignored). */
export const MARKER_LINE_RE = /^[ \t]*<!--[ \t]*otago:suggestions[ \t]*-->[ \t]*\r?$/;
/** An item line: `-`, `*`, `+`, `•` bullets or `1.` / `1)`; group 1 = raw item text. */
export const ITEM_LINE_RE = /^[ \t]*(?:[-*+•]|\d{1,3}[.)])(?:[ \t]+(.*?))?[ \t]*\r?$/;
/** A blank line. */
export const BLANK_LINE_RE = /^[ \t]*\r?$/;
/** Fence open / close (same rule as `removeFencedBlocks` in `agent/prompt.ts`). */
export const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
export const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

const MARKER_OPEN = '<!--';

/**
 * What one complete line did:
 * - `text`: ordinary answer text;
 * - `marker`: a marker line, a candidate block begins;
 * - `block`: a blank or item line inside the candidate block;
 * - `break`: the candidate block was abandoned, the line is ordinary text;
 * - `break-marker`: the candidate block was abandoned and the line starts a new one.
 */
type LineStep = 'text' | 'marker' | 'block' | 'break' | 'break-marker';

/** The grammar of block.ts: one left-to-right pass over complete lines (without `\n`). */
class LineMachine {
  /** Opening run of the fence the text is in. */
  private fence: string | undefined;
  /** Inside a candidate block (`blockStart` of the contract is set). */
  inBlock = false;
  /** A marker line outside fences was seen and abandoned. */
  rejected = false;

  get inFence(): boolean {
    return this.fence !== undefined;
  }

  step(line: string): LineStep {
    if (this.inBlock) {
      if (BLANK_LINE_RE.test(line) || ITEM_LINE_RE.test(line)) return 'block';
      this.inBlock = false;
      this.rejected = true;
      return this.normal(line) === 'marker' ? 'break-marker' : 'break';
    }
    return this.normal(line);
  }

  private normal(line: string): 'text' | 'marker' {
    if (this.fence !== undefined) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close && close[0] === this.fence[0] && close.length >= this.fence.length) {
        this.fence = undefined;
      }
      return 'text';
    }
    const open = FENCE_OPEN_RE.exec(line)?.[1];
    if (open) {
      this.fence = open;
      return 'text';
    }
    if (MARKER_LINE_RE.test(line)) {
      this.inBlock = true;
      return 'marker';
    }
    return 'text';
  }
}

/** An incomplete line that may still become a marker line (and so must be held). */
function couldBeMarker(line: string): boolean {
  const text = line.replace(/^[ \t]+/, '');
  return text.startsWith(MARKER_OPEN) || MARKER_OPEN.startsWith(text);
}

/**
 * Streaming filter, one per attempt: `push` every chunk and show only what it returns; call
 * `end()` after the last chunk (never after a cancel / failure). The concatenated output is the
 * text without the final block; nothing emitted is ever retracted.
 */
export class SuggestionBlockFilter {
  private readonly machine = new LineMachine();
  /** Text of the current incomplete line (classification only). */
  private line = '';
  /** The current line may still become a marker line. */
  private lineHoldable = true;
  /** Withheld output: the current line (normal mode) or the candidate block so far. */
  private held = '';
  /** Offset in `held` where the current line starts. */
  private lineStart = 0;

  /** Text that may be shown now (possibly `""`). */
  push(chunk: string): string {
    let out = '';
    let rest = chunk;
    while (rest !== '') {
      const newline = rest.indexOf('\n');
      if (newline === -1) {
        out += this.partial(rest);
        break;
      }
      out += this.complete(rest.slice(0, newline + 1));
      rest = rest.slice(newline + 1);
    }
    return out;
  }

  /** End of stream: held text that turned out not to be the final block (possibly `""`). */
  end(): string {
    let out = this.line === '' ? '' : this.complete('');
    if (this.machine.inBlock) {
      // The final block: withheld for good.
      this.held = '';
      this.lineStart = 0;
      return out;
    }
    out += this.held;
    this.held = '';
    this.lineStart = 0;
    return out;
  }

  private partial(piece: string): string {
    this.line += piece;
    if (this.machine.inBlock) {
      this.held += piece;
      return '';
    }
    if (!this.machine.inFence && this.lineHoldable && couldBeMarker(this.line)) {
      this.held += piece;
      return '';
    }
    this.lineHoldable = false;
    const out = this.held + piece;
    this.held = '';
    return out;
  }

  /** `tail` = the rest of the current line, with its `\n` (`""` at the end of the stream). */
  private complete(tail: string): string {
    const line = this.line + (tail.endsWith('\n') ? tail.slice(0, -1) : tail);
    this.line = '';
    this.lineHoldable = true;
    let out = '';
    switch (this.machine.step(line)) {
      case 'text':
      case 'break':
        out = this.held + tail;
        this.held = '';
        break;
      case 'marker':
      case 'block':
        this.held += tail;
        break;
      case 'break-marker':
        out = this.held.slice(0, this.lineStart);
        this.held = this.held.slice(this.lineStart) + tail;
        break;
    }
    this.lineStart = this.held.length;
    return out;
  }
}

/** Result of `splitSuggestionBlock`. */
export interface SplitAnswer {
  /** Text before the marker line, trailing whitespace removed (block found); else the input. */
  answer: string;
  /** Raw item texts in block order; `undefined` = no block, `[]` = empty block. */
  items?: string[];
  /** A marker line outside fences was seen but abandoned (it stays in the answer). */
  rejected: boolean;
}

/** Final split at save: the same machine as the filter, run over the whole text. */
export function splitSuggestionBlock(text: string): SplitAnswer {
  const machine = new LineMachine();
  const lines = text.split('\n');
  // A trailing newline leaves no incomplete line (as for the filter).
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  let offset = 0;
  let blockStart = -1;
  let items: string[] = [];
  for (const line of lines) {
    switch (machine.step(line)) {
      case 'marker':
      case 'break-marker':
        blockStart = offset;
        items = [];
        break;
      case 'block': {
        const item = ITEM_LINE_RE.exec(line);
        if (item) items.push(item[1] ?? '');
        break;
      }
      case 'break':
        blockStart = -1;
        break;
      case 'text':
        break;
    }
    offset += line.length + 1;
  }
  if (!machine.inBlock || blockStart === -1) return { answer: text, rejected: machine.rejected };
  return { answer: text.slice(0, blockStart).trimEnd(), items, rejected: machine.rejected };
}

/** A block to append to an answer (tests, demo simulator); texts must be single-line. */
export function suggestionBlock(texts: readonly string[]): string {
  const items = texts.map((text) => `- ${text}`).join('\n');
  return `\n\n${SUGGESTIONS_MARKER}${texts.length > 0 ? `\n${items}` : ''}`;
}
