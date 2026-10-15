// Suggested follow-up prompts: storage format, text rules, resolution and finalization.
// Mirrors .claude/features/suggested-prompts/contracts/{node-file,suggestions}.ts.
// Pure and Node-free (imports only ../text.js): demo/src/mock/ imports this file as-is.
import { collapseWhitespace, truncateGraphemes } from '../text.js';

/** One stored suggestion (`node.md` frontmatter). Readers ignore unknown item keys. */
export interface StoredSuggestion {
  /** Sanitized question text, sent verbatim when clicked. */
  text: string;
  /** Levels above the node it is asked from: `0` = own, `k ≥ 1` = the ancestor k levels up. */
  up: number;
}

/** A resolved suggestion (what clients render). */
export interface Suggestion {
  text: string;
  /** Node to ask from (current id): the viewed node, or an ancestor for inherited items. */
  target: string;
  /** Levels above the viewed node (`0` = own). */
  up: number;
}

/** Inheritance candidate offered to the generator. */
export interface SuggestionCandidate {
  text: string;
  /** Id of the ancestor that owns the text (up 0 there). */
  source: string;
  /** Index of that ancestor in the generation chain (0 = top-level node). */
  origin: number;
}

/** What the generator returns: a new own text, or a 0-based pick of a candidate. */
export type SuggestPick = { text: string } | { keep: number };

export interface SuggestionsReady {
  node: string;
  state: 'ready';
  suggestions: Suggestion[];
}

export interface SuggestionsMissing {
  node: string;
  state: 'missing';
  suggestions: [];
}

export type SuggestionsResponse = SuggestionsReady | SuggestionsMissing;

/** Frontmatter key of the stored list. */
export const SUGGESTIONS_KEY = 'suggestions';
/** At most this many items are stored per node (own first, then inherited). */
export const MAX_SUGGESTIONS = 5;
/** Text cap, in graphemes (no ellipsis). */
export const SUGGESTION_MAX_GRAPHEMES = 200;

/** The one equality of suggestion texts (dedupe, validation, "asked" and "used" checks). */
export function suggestionKey(text: string): string {
  return text.trim().normalize('NFC');
}

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Lone surrogates → U+FFFD (like `String#toWellFormed`, which ES2023 typings lack). */
function wellFormed(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.slice(i, i + 2);
        i++;
      } else {
        out += REPLACEMENT_CHAR;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += REPLACEMENT_CHAR;
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

/** Wrapping quote pairs, one of which is stripped when it wraps the whole text. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['«', '»'],
  ['“', '”'],
  ['„', '“'],
];

function stripWrappingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (
      text.length >= open.length + close.length &&
      text.startsWith(open) &&
      text.endsWith(close)
    ) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

/**
 * Clean a suggestion text: well-formed, NFC, one line, one pair of wrapping quotes stripped,
 * at most SUGGESTION_MAX_GRAPHEMES graphemes. `null` for a non-string or an empty result.
 */
export function sanitizeSuggestionText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // `\s` covers newlines and U+2028 / U+2029.
  let text = collapseWhitespace(wellFormed(raw).normalize('NFC'));
  text = stripWrappingQuotes(text);
  text = truncateGraphemes(text, SUGGESTION_MAX_GRAPHEMES).trim();
  return text || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parsed frontmatter value → stored list. Not an array → `undefined` (MISSING); invalid items
 * are dropped one by one (the list stays STORED); texts are re-sanitized.
 */
export function parseStoredSuggestions(value: unknown): StoredSuggestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: StoredSuggestion[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const text = sanitizeSuggestionText(item.text);
    const up = item.up;
    if (text === null || typeof up !== 'number' || !Number.isSafeInteger(up) || up < 0) continue;
    items.push({ text, up });
  }
  return items;
}

/** The frontmatter line `suggestions: <json>` (single line; U+2028 / U+2029 escaped). */
export function suggestionsLine(items: readonly StoredSuggestion[]): string {
  const json = JSON.stringify(items.map(({ text, up }) => ({ text, up })))
    .split(LINE_SEPARATOR)
    .join(`\\${'u2028'}`)
    .split(PARAGRAPH_SEPARATOR)
    .join(`\\${'u2029'}`);
  return `${SUGGESTIONS_KEY}: ${json}`;
}

const SUGGESTIONS_KEY_RE = new RegExp(`^${SUGGESTIONS_KEY}\\s*:`);

interface FrontmatterSlot {
  lines: string[];
  crlf: boolean;
  /** Index of the closing `---` line. */
  close: number;
  /** Lines `[start, end)` of an existing top-level `suggestions:` key (with continuations). */
  existing?: { start: number; end: number };
}

const bareLine = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);

function frontmatterSlot(fileText: string): FrontmatterSlot | undefined {
  if (!/^---\r?\n/.test(fileText)) return undefined;
  const lines = fileText.split('\n');
  const close = lines.findIndex((line, index) => index > 0 && bareLine(line) === '---');
  if (close === -1) return undefined;
  const crlf = fileText.startsWith('---\r\n');
  const start = lines.findIndex(
    (line, index) => index > 0 && index < close && SUGGESTIONS_KEY_RE.test(bareLine(line)),
  );
  if (start === -1) return { lines, crlf, close };
  let end = start + 1;
  // Continuation lines of a block-style value start with whitespace or `-`.
  while (end < close && /^[\s-]/.test(bareLine(lines[end] ?? ''))) end++;
  return { lines, crlf, close, existing: { start, end } };
}

/**
 * Textual splice of the suggestions line into a node.md text: replaces an existing top-level
 * `suggestions:` key (and its continuation lines) or inserts the line right before the
 * closing `---`. Every other byte is kept; the line ending follows the opening `---` line.
 * Throws when the text has no frontmatter block.
 */
export function setSuggestionsLine(fileText: string, items: readonly StoredSuggestion[]): string {
  const slot = frontmatterSlot(fileText);
  if (!slot) throw new Error('node.md has no frontmatter block');
  const line = suggestionsLine(items) + (slot.crlf ? '\r' : '');
  const { lines, existing } = slot;
  if (existing) lines.splice(existing.start, existing.end - existing.start, line);
  else lines.splice(slot.close, 0, line);
  return lines.join('\n');
}

/** The text without a top-level `suggestions:` key (unchanged when there is none). */
export function removeSuggestionsLine(fileText: string): string {
  const slot = frontmatterSlot(fileText);
  if (!slot?.existing) return fileText;
  slot.lines.splice(slot.existing.start, slot.existing.end - slot.existing.start);
  return slot.lines.join('\n');
}

/** A node of a chain as far as suggestions are concerned (top-level first). */
export interface SuggestionChainNode {
  id: string;
  suggestions?: StoredSuggestion[];
}

/** Keys of the live children's questions, per target node id. */
export type UsedKeysByTarget = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Distinct node ids the stored items of the chain's LAST node can point at (own → that node,
 * inherited → the ancestor `up` levels above). These are the targets whose children decide
 * "used". `[]` when the last node's list is missing.
 */
export function suggestionTargets(chain: readonly SuggestionChainNode[]): string[] {
  const last = chain.at(-1);
  if (!last?.suggestions) return [];
  const targets = new Set<string>();
  for (const item of last.suggestions) {
    const owner = chain[chain.length - 1 - item.up];
    if (owner && item.up < chain.length) targets.add(owner.id);
  }
  return [...targets];
}

/**
 * Resolution on read for the chain's LAST node V: own items target V, inherited items target
 * the ancestor they point at and are kept only while that ancestor still OWNS the same text;
 * deduped by key (first wins), "used" items dropped, capped. `'missing'` when V has no list.
 */
export function resolveSuggestions(
  chain: readonly SuggestionChainNode[],
  usedKeysByTarget: UsedKeysByTarget,
): Suggestion[] | 'missing' {
  const viewed = chain.at(-1);
  if (!viewed || viewed.suggestions === undefined) return 'missing';
  const resolved: Suggestion[] = [];
  const seen = new Set<string>();
  for (const item of viewed.suggestions) {
    const key = suggestionKey(item.text);
    let target = viewed.id;
    if (item.up > 0) {
      if (item.up >= chain.length) continue;
      const owner = chain[chain.length - 1 - item.up];
      if (!owner?.suggestions) continue;
      const owned = owner.suggestions.some(
        (own) => own.up === 0 && suggestionKey(own.text) === key,
      );
      if (!owned) continue;
      target = owner.id;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (usedKeysByTarget.get(target)?.has(key)) continue;
    resolved.push({ text: item.text, target, up: item.up });
    if (resolved.length >= MAX_SUGGESTIONS) break;
  }
  return resolved;
}

/** Index of the nearest node of `chain` (from the end) with a STORED list; `-1` when none. */
export function nearestStoredIndex(chain: readonly SuggestionChainNode[]): number {
  for (let index = chain.length - 1; index >= 0; index--) {
    if (chain[index]?.suggestions !== undefined) return index;
  }
  return -1;
}

/**
 * Inheritance candidates for a node whose ancestors are `chain` (top-level first): the
 * resolved list of the nearest ancestor with a stored list (missing ones are skipped; a stored
 * empty one stops inheritance), minus questions already asked along the chain. Each candidate
 * points at the ancestor that originally offered it.
 */
export function pickCandidates(
  chain: readonly SuggestionChainNode[],
  usedKeysByTarget: UsedKeysByTarget,
  askedKeys: ReadonlySet<string>,
): SuggestionCandidate[] {
  const nearest = nearestStoredIndex(chain);
  if (nearest === -1) return [];
  const resolved = resolveSuggestions(chain.slice(0, nearest + 1), usedKeysByTarget);
  if (resolved === 'missing') return [];
  return resolved
    .filter((item) => !askedKeys.has(suggestionKey(item.text)))
    .map((item) => ({ text: item.text, source: item.target, origin: nearest - item.up }));
}

/**
 * Finalization after generation: picks (model order) → stored items. Keeps reference a
 * candidate (text verbatim, `up` relative to the new node); new texts are sanitized and become
 * keeps when they equal a candidate. Asked questions and duplicates are dropped; own items
 * come first, then inherited ones; capped at MAX_SUGGESTIONS. May return `[]`.
 */
export function finalizeSuggestions(
  picks: readonly SuggestPick[],
  candidates: readonly SuggestionCandidate[],
  ctx: { depth: number; askedKeys: ReadonlySet<string> },
): StoredSuggestion[] {
  const candidateByKey = new Map<string, SuggestionCandidate>();
  for (const candidate of candidates) {
    const key = suggestionKey(candidate.text);
    if (!candidateByKey.has(key)) candidateByKey.set(key, candidate);
  }
  const fromCandidate = (candidate: SuggestionCandidate): StoredSuggestion | undefined => {
    const up = ctx.depth - candidate.origin;
    return up >= 1 ? { text: candidate.text, up } : undefined;
  };
  const items: StoredSuggestion[] = [];
  const seen = new Set<string>();
  for (const pick of picks as readonly unknown[]) {
    if (!isRecord(pick)) continue;
    let item: StoredSuggestion | undefined;
    if (typeof pick.text === 'string') {
      const text = sanitizeSuggestionText(pick.text);
      if (text === null) continue;
      const candidate = candidateByKey.get(suggestionKey(text));
      item = candidate ? fromCandidate(candidate) : { text, up: 0 };
    } else if (typeof pick.keep === 'number' && Number.isInteger(pick.keep)) {
      const candidate = candidates[pick.keep];
      item = candidate ? fromCandidate(candidate) : undefined;
    }
    if (!item) continue;
    const key = suggestionKey(item.text);
    if (ctx.askedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  const own = items.filter((item) => item.up === 0);
  const inherited = items.filter((item) => item.up > 0);
  return [...own, ...inherited].slice(0, MAX_SUGGESTIONS);
}
