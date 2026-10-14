/**
 * CONTRACT SPEC (planning artifact) — feature `parallel-questions`. Owner: server.
 * Unicode node folder names (= node id segments).
 *
 * DECISION (open question "exact Unicode slug rules"): restricted Unicode slug (research U2).
 *  - Applies to NODE names only. Tree ids stay ASCII kebab-case (out of scope; they are path
 *    params everywhere). The server splits the helpers: `isTreeId`/`toTreeId` (today's
 *    `isSlug`/`toKebabCase`, ASCII) vs `isNodeName`/`toNodeName` (this file).
 *  - Every node name that is valid today stays valid (ASCII slugs are a subset). Nothing on disk
 *    is renamed or migrated.
 *
 * Runtime home on the server: `server/src/storage/node-names.ts` (implementer mirrors these
 * constants; this file is the spec, not the module).
 */

/** One word: starts with a letter or decimal digit; combining marks only after a base char. */
export const NODE_WORD_SOURCE = String.raw`[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*`;

/**
 * Shape of a node name: words joined by single ASCII `-`. `u` flag.
 * Excludes: `.` (so trash folders `*.deleted-*` and `.tmp-*` staging are never names),
 * `/`, `\`, whitespace, punctuation, symbols/emoji, `\p{Cf}` (ZWJ, bidi controls), control chars.
 */
export const NODE_NAME_RE =
  /^[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*$/u;

/**
 * `isNodeName(s)` — validation of an EXISTING or REQUESTED name (node id segments, move
 * `names`, folders found on disk):
 *   NODE_NAME_RE.test(s) && s === s.normalize('NFC') && s === s.toLowerCase()
 * and `nameKey(s)` is not a reserved name for that level (`attachments`, `files`; at the tree
 * root also `sources`, `tree.md`).
 * NO length cap here, so long hand-made ASCII folders that are valid today stay valid.
 */
export type IsNodeName = (s: string) => boolean;

/** Caps applied by `toNodeName` (generated and user-renamed names). */
export const NODE_NAME_MAX_CODE_POINTS = 60;
/** Leaves room for `-NN` and `.deleted-<13 digits>-NN` under the 255-byte component limit. */
export const NODE_NAME_MAX_UTF8_BYTES = 100;
/** Words kept from a naming-model reply / fallback name (unchanged "2–4 words" rule). */
export const GENERATED_NAME_MAX_WORDS = 4;
export const NODE_NAME_FALLBACK = 'node';

/**
 * `toNodeName(input, { fallback = 'node', maxWords? })` — the ONE sanitizer for node names
 * (naming-model reply, fallback from the question, `POST /nodes/rename`, `createNode`):
 *   1. `input.normalize('NFKC')` (folds `ﬁ`, full-width letters, superscripts).
 *   2. `.toLowerCase()` — locale-independent (never `toLocaleLowerCase`); `ΟΔΟΣ` → `οδος`,
 *      `İ` → `i̇`.
 *   3. Split on `[^\p{L}\p{M}\p{Nd}]+`; drop leading `\p{M}` of every word; drop empty words.
 *   4. If `maxWords` is given keep only the first `maxWords` words.
 *   5. Join with `-`, normalize to NFC.
 *   6. While over NODE_NAME_MAX_CODE_POINTS or NODE_NAME_MAX_UTF8_BYTES and more than one word:
 *      drop the last word. If a single word is still too long, cut it at a GRAPHEME boundary
 *      (`Intl.Segmenter`, never `String.prototype.slice`) to fit both caps.
 *   7. Result empty, or `!isNodeName(result)` → `fallback`.
 * Invariant (property-tested): `isNodeName(toNodeName(x))` for every string `x`, and
 * `toNodeName(toNodeName(x)) === toNodeName(x)`.
 *
 * Examples:
 *   'Правила Заимствования'      → 'правила-заимствования'
 *   'Привет'                     → 'привет'        (today: 'node')
 *   'Borrowing Rules'            → 'borrowing-rules'
 *   'Café crème'                 → 'café-crème'    (today: 'cafe-creme'; accents kept now)
 *   'हिन्दी नाम'                  → 'हिन्दी-नाम'     (Devanagari needs \p{M})
 *   '👩‍👩‍👧 !!!'                     → 'node'
 *   '../../etc/passwd'           → 'etc-passwd'
 */
export type ToNodeName = (
  input: string,
  options?: { fallback?: string; maxWords?: number },
) => string;

/**
 * Comparison key for sibling uniqueness, reserved names and in-process name claims:
 *   nameKey(s) = s.normalize('NFC').toUpperCase().toLowerCase()
 * Reproduces the case-insensitive APFS folding (`ß`/`ss`, `ς`/`σ`, `ﬁ`/`fi` collide; `ё`/`е`
 * do not). Two siblings never share a key; a candidate whose key is taken gets `-2`, `-3`, …
 * Creation retry loops add a candidate that failed with EEXIST/ENOTEMPTY to a per-call
 * "failed" set, so the next attempt advances to the next suffix.
 */
export type NameKey = (s: string) => string;

/**
 * Soft-deleted folder name. CHANGED: the `name` group is a Unicode node name.
 * The regex alone does NOT enforce NFC/lowercase (e.g. `A.deleted-1759000000000` matches it),
 * so `isDeletedName`/`parseTrashId` ALSO require `isNodeName(groups.name)`; otherwise 400.
 * `\d` stays ASCII under the `u` flag (timestamps are ASCII digits).
 * The `-2` collision suffix and the `.` that keeps trash folders non-names are unchanged.
 */
export const DELETED_NAME_RE =
  /^(?<name>[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*(?:-[\p{L}\p{Nd}][\p{L}\p{M}\p{Nd}]*)*)\.deleted-(?<ts>\d{13,})(?:-(?<n>[2-9]|[1-9]\d+))?$/u;

/**
 * Normalization and transport rules:
 *  - Every node id / trash id / desired name accepted by the API is normalized to NFC by the
 *    route schema (`z.string().normalize('NFC')`) BEFORE validation. An NFD id (e.g. a pasted
 *    macOS path) therefore resolves to the same node.
 *  - Every id the server returns is NFC. Hierarchy reading normalizes folder names from
 *    `readdir` to NFC before validating and building ids; a second entry with the same
 *    `nameKey` (NFC/NFD twins on normalization-sensitive file systems) is skipped.
 *  - Ids travel in query strings and JSON bodies only (never in path params), percent-encoded
 *    UTF-8 (`URLSearchParams` / `encodeURIComponent`). The web's cosmetic `%2F` → `/` stays.
 *  - Clients must normalize ids read from their own URL to NFC before comparing them
 *    (`URLSearchParams` does not normalize).
 *  - Sibling order is unchanged (`created`, then name). Mixed-script siblings are allowed.
 *
 * Known limitations (documented, not handled): homoglyph siblings (Latin `a` vs Cyrillic `а`)
 * are distinct names; on Linux an NFD folder created outside Otago is listed with its NFC id
 * but cannot be opened by it; deep multibyte trees reach PATH_MAX (1024 bytes on macOS) sooner.
 */
export type NodeNameTransport = never;
