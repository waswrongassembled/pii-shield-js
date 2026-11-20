import { DIGIT, SPACE } from './internal/pcre.js';

const OPEN = '⟦';
const CLOSE = '⟧';

/**
 * PHP's Placeholder::TOLERANT_PATTERN. It is a /u pattern, so \s and \d are Unicode-aware (PCRE2_UCP):
 * "⟦PERSON\u{A0}1⟧" is found, and the number may contain non-ASCII digits (kept as they are).
 * Letters stay ASCII ([A-Za-z], no i flag), so "K" (U+212A) or "ſ" never start a type.
 */
const TOLERANT = new RegExp(
  String.raw`(?:⟦|\[\[)${SPACE}*(?<type>[A-Za-z][A-Za-z0-9]*(?:(?:\\?_|${SPACE}+)[A-Za-z0-9]+)*)(?:\\?_|${SPACE}+)(?<number>${DIGIT}+)${SPACE}*(?:⟧|\]\])`,
  'gu',
);

/**
 * PHP replaces the separators inside the type with a pattern *without* /u, so only ASCII whitespace
 * (\t \n \v \f \r and space) becomes "_"; a no-break space inside the type stays and the placeholder is unknown.
 */
const TYPE_SEPARATOR = /\\?_|[\t\n\v\f\r ]+/g;

/**
 * Canonical placeholder "⟦TYPE_N⟧" (wire format, identical to PHP).
 *
 * @param type an EntityType value or the name of a learned type (see typeName())
 * @param number counter per type, starting at 1
 */
export function formatPlaceholder(type: string, number: number): string {
  return `${OPEN}${type}_${String(number)}${CLOSE}`;
}

/**
 * Calls `replace` for every placeholder in `text` and returns the text with the return values in place.
 *
 * Parsing tolerates what models do to placeholders: case changes, inner whitespace, a space instead of
 * an underscore, markdown-escaped underscores (`\_`) and ASCII `[[...]]` brackets. Type names may contain
 * digits (learned types such as "VN2_NUMBER"); the last number is the counter.
 *
 * @param replace receives the canonical form (e.g. "⟦TAX_NUMBER_1⟧") and the text as found (e.g. "[[tax number 1]]")
 */
export function replacePlaceholders(text: string, replace: (canonical: string, original: string) => string): string {
  return text.replace(TOLERANT, (original: string, ...rest: unknown[]) => {
    const groups = rest.at(-1) as { type: string; number: string };
    const type = asciiUpper(groups.type.replace(TYPE_SEPARATOR, '_'));

    return replace(`${OPEN}${type}_${groups.number}${CLOSE}`, original);
  });
}

const TOLERANT_AT = new RegExp(TOLERANT.source, 'uy');

/**
 * Length of the (tolerant) placeholder that starts exactly at `index`, or -1.
 *
 * @internal
 */
export function placeholderLengthAt(text: string, index: number): number {
  TOLERANT_AT.lastIndex = index;
  const match = TOLERANT_AT.exec(text);

  return match === null ? -1 : match[0].length;
}

const IS_SPACE = new RegExp(`^${SPACE}$`, 'u');
const IS_DIGIT = new RegExp(`^${DIGIT}$`, 'u');
const IS_LETTER = /^[A-Za-z]$/;
const IS_ALNUM = /^[A-Za-z0-9]$/;

// States of an automaton that follows TOLERANT from its start (a bit set: the pattern is ambiguous).
const START = 1; // nothing read yet
const HALF_OPEN = 2; // the first [ of [[
const AFTER_OPEN = 4; // ⟦ or [[ and optional spaces
const IN_TYPE = 8; // inside a type token [A-Za-z0-9]+
const AFTER_BACKSLASH = 16; // \ of an escaped underscore
const AFTER_UNDERSCORE = 32; // _ separator
const AFTER_SPACE = 64; // whitespace separator
const IN_NUMBER = 128; // counter digits
const AFTER_NUMBER = 256; // spaces before the closing bracket
const AFTER_FIRST_CLOSE = 512; // first ] of ]]
const DONE = 1024; // closing bracket read: TOLERANT matches

/**
 * Incremental check whether a text can still grow into a placeholder that TOLERANT matches at its start.
 * Start with `PLACEHOLDER_PREFIX_START` and feed one code point at a time to `stepPlaceholderPrefix()`;
 * the result is 0 when it can no longer become one and has `PLACEHOLDER_PREFIX_DONE` set when it is complete.
 *
 * @internal
 */
export const PLACEHOLDER_PREFIX_START = START;
/** @internal */
export const PLACEHOLDER_PREFIX_DONE = DONE;

/** @internal */
export function stepPlaceholderPrefix(states: number, c: string): number {
  const space = IS_SPACE.test(c);
  const digit = IS_DIGIT.test(c);
  const alnum = IS_ALNUM.test(c);
  let next = 0;
  if (states & START) next |= c === OPEN ? AFTER_OPEN : c === '[' ? HALF_OPEN : 0;
  if (states & HALF_OPEN && c === '[') next |= AFTER_OPEN;
  if (states & AFTER_OPEN) next |= (space ? AFTER_OPEN : 0) | (IS_LETTER.test(c) ? IN_TYPE : 0);
  if (states & IN_TYPE) {
    next |= (alnum ? IN_TYPE : 0) | (space ? AFTER_SPACE : 0);
    next |= c === '\\' ? AFTER_BACKSLASH : c === '_' ? AFTER_UNDERSCORE : 0;
  }
  if (states & AFTER_BACKSLASH && c === '_') next |= AFTER_UNDERSCORE;
  if (states & AFTER_UNDERSCORE) next |= (alnum ? IN_TYPE : 0) | (digit ? IN_NUMBER : 0);
  if (states & AFTER_SPACE) next |= (space ? AFTER_SPACE : 0) | (alnum ? IN_TYPE : 0) | (digit ? IN_NUMBER : 0);
  if (states & IN_NUMBER) next |= (digit ? IN_NUMBER : 0) | (space ? AFTER_NUMBER : 0);
  if (states & AFTER_NUMBER && space) next |= AFTER_NUMBER;
  if (states & (IN_NUMBER | AFTER_NUMBER)) next |= c === ']' ? AFTER_FIRST_CLOSE : c === CLOSE ? DONE : 0;
  if (states & AFTER_FIRST_CLOSE && c === ']') next |= DONE;

  return next;
}

/**
 * Automaton state after reading `text` from `index` to its end (0: it cannot become a placeholder).
 *
 * @internal
 */
export function placeholderPrefixState(text: string, index: number): number {
  let states = START;
  for (let i = index; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i) ?? 0);
    states = stepPlaceholderPrefix(states, c);
    if (states === 0) {
      return 0;
    }
    i += c.length;
  }

  return states;
}

/**
 * Whether `text` from `index` to its end is an unfinished placeholder: it starts with an opening bracket
 * and nothing so far rules it out. Used to hold back stream chunks.
 *
 * @internal
 */
export function isPlaceholderPrefix(text: string, index: number): boolean {
  return (placeholderPrefixState(text, index) & ~DONE) !== 0;
}

/** PHP's strtoupper(): ASCII only. */
function asciiUpper(text: string): string {
  return text.replace(/[a-z]+/g, (s) => s.toUpperCase());
}
