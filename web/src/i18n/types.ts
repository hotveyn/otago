/** Russian needs more plural forms than English (`_one`/`_other`). */
type ExtraPluralKeys = { [key: `${string}_${'few' | 'many'}`]: string };

/** Same keys as the English messages (plus extra plural forms), any string values. */
export type Messages<T> = {
  [K in keyof T]: T[K] extends string ? string : Messages<T[K]>;
} & ExtraPluralKeys;
