/**
 * Building blocks that make JavaScript regexes behave like the PHP package's PCRE patterns.
 *
 * PHP's /u modifier turns on PCRE2_UTF and PCRE2_UCP, so \d, \w, \s and \b are Unicode-aware there,
 * while JavaScript's are ASCII (\d, \w, \b) or a different Unicode set (\s). Patterns ported from a
 * PHP /u regex use these classes instead. They were checked code point by code point against PHP 8.5
 * (PCRE2 10.49) and Node 24 (Unicode 17).
 *
 * Without /u PHP matches bytes: \d, \w and \s are ASCII there, which JavaScript's \d and \w already are.
 *
 * @internal
 */

/** PCRE UCP \w as the inside of a character class. */
export const WORD_CHARS = String.raw`\p{L}\p{N}\p{Mn}\p{Pc}`;
/** PCRE UCP \w. */
export const WORD = `[${WORD_CHARS}]`;
/** PCRE UCP \s as the inside of a character class: JS \s lacks U+0085 and U+180E and adds U+FEFF. */
export const SPACE_CHARS = String.raw`\t-\r \x85\xA0\u{1680}\u{180E}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}`;
/** PCRE UCP \s. */
export const SPACE = `[${SPACE_CHARS}]`;
/** PCRE UCP \d. */
export const DIGIT = String.raw`\p{Nd}`;
/** PCRE \b at a position followed by a word character (e.g. `\bAmt`). */
export const WORD_START = `(?<!${WORD})`;
/** PCRE \b at a position preceded by a word character (e.g. `Amt\b`). */
export const WORD_END = `(?!${WORD})`;
/** PCRE ^ with /m: PHP's PCRE only treats "\n" as a newline, JavaScript also "\r", U+2028 and U+2029. */
export const LINE_START = String.raw`(?<![^\n])`;
/** PCRE $ with /m (see LINE_START). */
export const LINE_END = String.raw`(?![^\n])`;

/** A regex match of a whole pattern or a named group, with its UTF-16 offset. */
export interface RegexMatch {
  readonly value: string;
  readonly offset: number;
}

/**
 * All matches of a global regex in text order, like PHP's preg_match_all(). With a group name, the regex
 * needs the "d" flag; matches where the group is unmatched or empty are skipped (as RegexMatcher does).
 */
export function matchAll(regex: RegExp, text: string, group?: string): RegexMatch[] {
  const result: RegexMatch[] = [];
  for (const match of text.matchAll(regex)) {
    if (group === undefined) {
      if (match[0] !== '') {
        result.push({ value: match[0], offset: match.index });
      }
      continue;
    }
    const value = match.groups?.[group];
    const span = match.indices?.groups?.[group];
    if (value !== undefined && value !== '' && span !== undefined) {
      result.push({ value, offset: span[0] });
    }
  }

  return result;
}

/** Number of code points, as PHP's mb_strlen() counts. */
export function codePointLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }
    length++;
  }

  return length;
}

/** PHP's intval() for decimal strings: leading " \t\n\r\v\f", optional sign, ASCII digits; anything else ends it. */
export function phpIntval(text: string): number {
  const match = /^[ \t\n\r\v\f]*([+-]?[0-9]+)/.exec(text);

  return match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

/** PHP's checkdate(). */
export function checkdate(month: number, day: number, year: number): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1 || year > 32767) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;

  return day <= days;
}

/** PHP's trim() without a character list: ASCII whitespace and NUL only. */
export function phpTrim(text: string): string {
  return text.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, '');
}
