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

/** PHP's strtoupper(): ASCII only. */
function asciiUpper(text: string): string {
  return text.replace(/[a-z]+/g, (s) => s.toUpperCase());
}
