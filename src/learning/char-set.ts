/**
 * Sets of code points as sorted, merged [lo, hi] range lists, with the PCRE2 UCP meaning of \d, \w and \s.
 *
 * Learned patterns are matched by our own engine (see learned-pattern.ts), so the classes are plain data
 * here instead of JavaScript regex syntax. The Unicode tables are derived once from the runtime's
 * property escapes (the same ones src/internal/pcre.ts uses).
 *
 * @internal
 */

export const MAX_CODE_POINT = 0x10ffff;

/** Flat [lo0, hi0, lo1, hi1, ...], sorted and merged, inclusive bounds. */
export type Ranges = readonly number[];

export function rangesFrom(pairs: readonly (readonly [number, number])[]): Ranges {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [lo, hi] of sorted) {
    const last = out.length - 1;
    if (last > 0 && lo <= (out[last] ?? 0) + 1) {
      out[last] = Math.max(out[last] ?? 0, hi);
    } else {
      out.push(lo, hi);
    }
  }

  return out;
}

export function union(...sets: Ranges[]): Ranges {
  const pairs: [number, number][] = [];
  for (const set of sets) {
    for (let i = 0; i < set.length; i += 2) {
      pairs.push([set[i] ?? 0, set[i + 1] ?? 0]);
    }
  }

  return rangesFrom(pairs);
}

export function complement(set: Ranges): Ranges {
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < set.length; i += 2) {
    const lo = set[i] ?? 0;
    const hi = set[i + 1] ?? 0;
    if (lo > next) {
      out.push(next, lo - 1);
    }
    next = hi + 1;
  }
  if (next <= MAX_CODE_POINT) {
    out.push(next, MAX_CODE_POINT);
  }

  return out;
}

export function intersects(a: Ranges, b: Ranges): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const aLo = a[i] ?? 0;
    const aHi = a[i + 1] ?? 0;
    const bLo = b[j] ?? 0;
    const bHi = b[j + 1] ?? 0;
    if (aLo <= bHi && bLo <= aHi) {
      return true;
    }
    if (aHi < bHi) {
      i += 2;
    } else {
      j += 2;
    }
  }

  return false;
}

export function isSubset(a: Ranges, b: Ranges): boolean {
  return !intersects(a, complement(b));
}

/** Fast membership test: ASCII bitmap plus binary search. */
export function membership(set: Ranges): (cp: number) => boolean {
  const ascii = new Uint8Array(128);
  for (let cp = 0; cp < 128; cp++) {
    ascii[cp] = contains(set, cp) ? 1 : 0;
  }
  const flat = Int32Array.from(set);

  return (cp) => (cp < 128 ? ascii[cp] === 1 : contains(flat, cp));
}

function contains(set: ArrayLike<number>, cp: number): boolean {
  let lo = 0;
  let hi = set.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < (set[mid * 2] ?? 0)) {
      hi = mid - 1;
    } else if (cp > (set[mid * 2 + 1] ?? 0)) {
      lo = mid + 1;
    } else {
      return true;
    }
  }

  return false;
}

let allCodePoints: string | undefined;

/** Ranges of all code points a single-character Unicode regex matches. */
function tableOf(regex: RegExp): Ranges {
  if (allCodePoints === undefined) {
    // Every scalar value in order; surrogates are in no property class used here.
    const parts: string[] = [];
    for (let cp = 0; cp <= MAX_CODE_POINT; cp += 0x1000) {
      const chunk: number[] = [];
      for (let c = cp; c < cp + 0x1000; c++) {
        if (c < 0xd800 || c > 0xdfff) {
          chunk.push(c);
        }
      }
      parts.push(String.fromCodePoint(...chunk));
    }
    allCodePoints = parts.join('');
  }
  const runs = new RegExp(`(?:${regex.source})+`, 'gu');
  const pairs: [number, number][] = [];
  for (const match of allCodePoints.matchAll(runs)) {
    const run = match[0];
    const first = run.codePointAt(0) ?? 0;
    const lastUnit = run.charCodeAt(run.length - 1);
    const last = run.codePointAt(lastUnit >= 0xdc00 && lastUnit <= 0xdfff ? run.length - 2 : run.length - 1) ?? first;
    // Runs never cross the surrogate gap (U+D7FC..U+D7FF and U+E000 are in none of these classes).
    pairs.push([first, last]);
  }

  return rangesFrom(pairs);
}

const cache = new Map<string, Ranges>();

function lazy(key: string, build: () => Ranges): Ranges {
  let set = cache.get(key);
  if (set === undefined) {
    set = build();
    cache.set(key, set);
  }

  return set;
}

/** PCRE UCP \d. */
export const digit = (): Ranges => lazy('d', () => tableOf(/\p{Nd}/u));
/** PCRE UCP \w: letters, numbers, non-spacing marks, connector punctuation. */
export const word = (): Ranges => lazy('w', () => tableOf(/[\p{L}\p{N}\p{Mn}\p{Pc}]/u));
/** Letters and numbers: the boundary class of learned patterns (`(?<![\p{L}\p{N}])`). */
export const letterOrNumber = (): Ranges => lazy('ln', () => tableOf(/[\p{L}\p{N}]/u));
/** PCRE UCP \s (see SPACE_CHARS in src/internal/pcre.ts). */
export const space = (): Ranges =>
  lazy('s', () =>
    rangesFrom([
      [0x09, 0x0d],
      [0x20, 0x20],
      [0x85, 0x85],
      [0xa0, 0xa0],
      [0x1680, 0x1680],
      [0x180e, 0x180e],
      [0x2000, 0x200a],
      [0x2028, 0x2029],
      [0x202f, 0x202f],
      [0x205f, 0x205f],
      [0x3000, 0x3000],
    ]),
  );
/** PCRE "." without /s: everything except "\n". */
export const dot = (): Ranges => lazy('.', () => complement([0x0a, 0x0a]));
