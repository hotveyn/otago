// Node-free (bundled by demo/): no `node:` imports here.
import { utf8Length } from '../text.js';

/**
 * Shape of a source file name (`sources/<name>`): starts with a letter or digit, then letters,
 * combining marks, digits, `.`, `_`, `-`, space, `,`, `(`, `)`, `'`, `’`, `+`, `&`.
 * Excludes `/`, `\`, `:`, control chars, `\p{Cf}` and other symbols; `..` and a trailing space
 * or dot are rejected separately. Up to 200 code points.
 */
export const SOURCE_NAME_RE = /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}._ ,()'’+&-]{0,199}$/u;

/** Leaves room for the `.md` companion of an e-book under the 255-byte component limit. */
export const SOURCE_NAME_MAX_UTF8_BYTES = 240;

/** Validates a stored or uploaded source file name (any normalization form). */
export function isSourceFileName(name: string): boolean {
  return (
    SOURCE_NAME_RE.test(name) &&
    !name.includes('..') &&
    !/[ .]$/.test(name) &&
    utf8Length(name) <= SOURCE_NAME_MAX_UTF8_BYTES
  );
}
