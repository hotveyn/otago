// Mirrors .claude/features/parallel-questions/contracts/node-names.ts
import { graphemes, utf8Length } from '../text.js';

/** One word: starts with a letter or decimal digit; combining marks only after a base char. */
export const NODE_WORD_SOURCE = String.raw`[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*`;

/**
 * Shape of a node folder name (= node id segment): words joined by single ASCII `-`.
 * Excludes `.` (trash `*.deleted-*` and `.tmp-*` staging are never names), `/`, `\`,
 * whitespace, punctuation, symbols/emoji, `\p{Cf}` (ZWJ, bidi controls) and control chars.
 */
export const NODE_NAME_RE =
  /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*$/u;

/** Caps applied by `toNodeName` (generated and user-renamed names). */
export const NODE_NAME_MAX_CODE_POINTS = 60;
/** Leaves room for `-NN` and `.deleted-<13 digits>-NN` under the 255-byte component limit. */
export const NODE_NAME_MAX_UTF8_BYTES = 100;
/** Words kept from a naming-model reply / fallback name. */
export const GENERATED_NAME_MAX_WORDS = 4;
export const NODE_NAME_FALLBACK = 'node';

const SEPARATOR_RE = /[^\p{L}\p{M}\p{Nd}]+/u;
const LEADING_MARKS_RE = /^\p{M}+/u;

/**
 * Comparison key for sibling uniqueness, reserved names and in-process name claims.
 * Reproduces case-insensitive APFS folding: `ß`/`ss`, `ς`/`σ`, `ﬁ`/`fi` collide; `ё`/`е` do not.
 */
export function nameKey(s: string): string {
  return s.normalize('NFC').toUpperCase().toLowerCase();
}

/**
 * Validates an existing or requested node name: shape, NFC and lowercase. No length cap, so
 * long hand-made ASCII folders stay valid. Reserved names are checked separately
 * (`isReservedName`), because they depend on the level.
 */
export function isNodeName(s: string): boolean {
  return NODE_NAME_RE.test(s) && s === s.normalize('NFC') && s === s.toLowerCase();
}

function fitsCaps(s: string): boolean {
  return [...s].length <= NODE_NAME_MAX_CODE_POINTS && utf8Length(s) <= NODE_NAME_MAX_UTF8_BYTES;
}

/** Longest grapheme-aligned prefix of `word` within both caps (may be `""`). */
function cutToCaps(word: string): string {
  let kept = '';
  for (const part of graphemes(word)) {
    if (!fitsCaps(kept + part)) break;
    kept += part;
  }
  return kept;
}

export interface ToNodeNameOptions {
  /** Returned when nothing usable is left. Default `node`. */
  fallback?: string;
  /** Keep only the first N words. */
  maxWords?: number;
}

/**
 * The one sanitizer for node names (naming-model reply, fallback from the question,
 * `POST /nodes/rename`, `createNode`). Always returns a valid node name or `fallback`:
 *   1. NFKC (folds `ﬁ`, full-width letters, superscripts);
 *   2. locale-independent `toLowerCase()`;
 *   3. split on anything but letters/marks/digits, drop leading marks of every word;
 *   4. keep `maxWords` words; 5. join with `-`, NFC;
 *   6. drop trailing words while over 60 code points / 100 UTF-8 bytes, then cut a single
 *      long word at a grapheme boundary;
 *   7. empty or invalid → `fallback`.
 */
export function toNodeName(input: string, options: ToNodeNameOptions = {}): string {
  const fallback = options.fallback ?? NODE_NAME_FALLBACK;
  let words = input
    .normalize('NFKC')
    .toLowerCase()
    .split(SEPARATOR_RE)
    .map((word) => word.replace(LEADING_MARKS_RE, '').normalize('NFC'))
    .filter(Boolean);
  if (options.maxWords !== undefined) words = words.slice(0, Math.max(0, options.maxWords));
  while (words.length > 1 && !fitsCaps(words.join('-'))) words.pop();
  let name = words.join('-');
  if (!fitsCaps(name)) name = cutToCaps(name);
  return name && isNodeName(name) ? name : fallback;
}
