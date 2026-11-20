/**
 * Whitelist grammar for hand-written patterns, parsed left to right (port of PHP's PatternGrammar).
 *
 * Allowed: literals, escaped metacharacters, \d \D \w \W \s \S, ".", character classes "[...]"
 * (literals, ranges, the same escapes), alternation "|", groups "(...)" and "(?:...)" WITHOUT a
 * quantifier, and quantifiers * + ? {n} {n,} {n,m} directly after a single atom.
 * The messages are part of the service API and identical to PHP.
 *
 * @internal
 */

const MAX_BOUND = 100;
const ESCAPABLE = '.^$|()[]{}*+?\\-/~#';
const CLASS_SHORTHANDS = 'dDwWsS';

/** Why the pattern is not allowed, or null if it is. */
export function patternViolation(pattern: string): string | null {
  const chars = Array.from(pattern);
  const count = chars.length;
  let depth = 0;
  let lastWasAtom = false;
  let afterGroup = false;
  let unbounded = 0;

  for (let i = 0; i < count; ++i) {
    const c = chars[i] ?? '';

    switch (c) {
      case '\\': {
        const next = chars[i + 1];
        if (next === undefined || (!CLASS_SHORTHANDS.includes(next) && !ESCAPABLE.includes(next))) {
          return `the escape \\${next ?? ''} is not allowed (use \\d \\w \\s or escape a special character)`;
        }
        ++i;
        lastWasAtom = true;
        afterGroup = false;
        break;
      }

      case '[': {
        const end = classEnd(chars, i);
        if (end === null) {
          return 'a character class is not closed or contains an escape that is not allowed';
        }
        i = end;
        lastWasAtom = true;
        afterGroup = false;
        break;
      }

      case '(':
        if (chars[i + 1] === '?') {
          if (chars[i + 2] !== ':') {
            return 'only (…) and (?:…) groups are allowed (no lookarounds, flags or named groups)';
          }
          i += 2;
        }
        ++depth;
        lastWasAtom = false;
        afterGroup = false;
        break;

      case ')':
        if (depth-- === 0) {
          return 'unbalanced parenthesis';
        }
        lastWasAtom = false;
        afterGroup = true;
        break;

      case '|':
        lastWasAtom = false;
        afterGroup = false;
        break;

      case '*':
      case '+':
      case '?':
      case '{': {
        if (afterGroup) {
          return 'groups must not be repeated; repeat single characters or classes instead';
        }
        if (!lastWasAtom) {
          return 'a quantifier must follow a single character or class';
        }
        let isUnbounded = c === '*' || c === '+';
        if (c === '{') {
          const end = boundedQuantifierEnd(chars, i);
          if (end === null) {
            return `use {n}, {n,} or {n,m} with numbers up to ${String(MAX_BOUND)}`;
          }
          isUnbounded = chars[end - 1] === ',';
          i = end;
        }
        if (isUnbounded && ++unbounded > 1) {
          return 'at most one unbounded repetition (*, + or {n,}) per pattern; use {n,m}';
        }
        if (chars[i + 1] === '?' || chars[i + 1] === '+') {
          return 'lazy and possessive quantifiers are not allowed';
        }
        lastWasAtom = false;
        break;
      }

      case '^':
      case '$':
        return 'anchors are not allowed; patterns are matched as whole words anyway';

      case ']':
      case '}':
        return `unexpected "${c}"; escape it as \\${c}`;

      default:
        lastWasAtom = true;
        afterGroup = false;
    }
  }

  return depth === 0 ? null : 'unbalanced parenthesis';
}

/** Index of the closing "]", or null. */
function classEnd(chars: readonly string[], start: number): number | null {
  let i = start + 1;
  if (chars[i] === '^') {
    ++i;
  }
  for (let first = true; i < chars.length; ++i, first = false) {
    const c = chars[i];
    if (c === ']' && !first) {
      return i;
    }
    if (c === '[') {
      return null;
    }
    if (c === '\\') {
      const next = chars[i + 1];
      if (next === undefined || (!CLASS_SHORTHANDS.includes(next) && !ESCAPABLE.includes(next))) {
        return null;
      }
      ++i;
    }
  }

  return null;
}

/** Index of the closing "}", or null. */
function boundedQuantifierEnd(chars: readonly string[], start: number): number | null {
  let body = '';
  let i = start + 1;
  for (; i < chars.length && chars[i] !== '}'; ++i) {
    body += chars[i] ?? '';
  }
  // PHP's check has no /u (\d is ASCII), and its $ also matches before a final "\n".
  const m = /^([0-9]{1,3})(?:,([0-9]{0,3}))?\n?$/.exec(body);
  if (chars[i] !== '}' || m === null) {
    return null;
  }
  if (Number(m[1]) > MAX_BOUND || (m[2] !== undefined && m[2] !== '' && Number(m[2]) > MAX_BOUND)) {
    return null;
  }

  return i;
}
