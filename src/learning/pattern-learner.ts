import { LearningError } from '../errors.js';
import { codePointLength, DIGIT, phpTrim, SPACE } from '../internal/pcre.js';
import { LearnedPattern } from './learned-pattern.js';

const MAX_SHAPES = 5;
const CLASSES: Record<string, string> = { U: '[A-Z]', L: '[a-z]', D: String.raw`\d` };
/** Used only when the examples contain umlauts, to keep patterns readable otherwise. */
const UMLAUT_CLASSES: Record<string, string> = { U: '[A-ZÄÖÜ]', L: '[a-zäöüß]' };

/** PHP: preg_match_all('/[A-ZÄÖÜ]+|[a-zäöüß]+|\d+|\s+|./u') — UCP \d and \s, "." without "\n". */
const TOKEN = new RegExp(`[A-ZÄÖÜ]+|[a-zäöüß]+|${DIGIT}+|${SPACE}+|[^\\n]`, 'gu');

interface Token {
  readonly kind: 'U' | 'L' | 'D' | 'S' | 'P';
  readonly text: string;
}

/**
 * Derives a pattern (PCRE syntax, as stored) from examples, e.g. "AB-1234/56" + "XY-9876/01" → `[A-Z]{2}-\d{4}/\d{2}`.
 *
 * Each example is split into runs of upper-case letters, lower-case letters, digits, whitespace and
 * single other characters. Examples with the same shape are merged (lengths become ranges, runs that
 * are identical in all of at least two examples stay literal); different shapes become alternatives.
 *
 * @throws LearningError, with code `LEARNING_PLAIN_WORDS` when the examples are plain words
 */
export function learnPattern(examples: readonly string[], counterExamples: readonly string[] = []): string {
  const unique = [...new Set(examples.map(phpTrim).filter((e) => e !== ''))];
  if (unique.length === 0) {
    throw new LearningError('At least one example is needed.');
  }

  const groups = new Map<string, Token[][]>();
  for (const example of unique) {
    const tokens = tokenize(example);
    const shape = tokens.map((t) => (t.kind === 'P' ? `P${t.text}` : t.kind)).join('\0');
    const group = groups.get(shape);
    if (group === undefined) {
      groups.set(shape, [tokens]);
    } else {
      group.push(tokens);
    }
  }
  if (groups.size > MAX_SHAPES) {
    throw new LearningError('The examples are too different to share a pattern. Split them into several types.');
  }

  const alternatives = [...groups.values()].map(merge);
  const pattern = alternatives.length === 1 ? (alternatives[0] ?? '') : `(?:${alternatives.join('|')})`;

  if (!isSpecific([...groups.values()])) {
    throw new LearningError(
      'Plain words cannot be learned as a pattern; they would match ordinary text. Use model-based detection for names and words.',
      'LEARNING_PLAIN_WORDS',
    );
  }
  // Learned patterns always compile; like preg_match() returning false, a failure would match nothing.
  const compiled = LearnedPattern.compile(pattern);
  counterExamples.forEach((counter, i) => {
    if (compiled instanceof LearnedPattern && compiled.matchesWhole(phpTrim(counter))) {
      throw new LearningError(
        `The learned pattern ${pattern} also matches counter-example ${String(i + 1)}. Add more examples or enter a pattern by hand.`,
      );
    }
  });

  return pattern;
}

function tokenize(example: string): Token[] {
  return Array.from(example.matchAll(TOKEN), ([run]) => ({ kind: kindOf(run), text: run }));
}

function kindOf(run: string): Token['kind'] {
  if (/^[A-ZÄÖÜ]/u.test(run)) {
    return 'U';
  }
  if (/^[a-zäöüß]/u.test(run)) {
    return 'L';
  }
  if (/^[0-9]+$/.test(run)) {
    return 'D'; // ctype_digit(): ASCII only, so other digits are literals
  }
  if (phpTrim(run) === '') {
    return 'S'; // trim(): ASCII whitespace only
  }

  return 'P';
}

function merge(examples: Token[][]): string {
  let pattern = '';
  (examples[0] ?? []).forEach((token, i) => {
    const texts = examples.map((tokens) => tokens[i]?.text ?? '');
    const lengths = texts.map(codePointLength);
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);

    if (token.kind === 'P') {
      pattern += escape(token.text);
    } else if (token.kind === 'S') {
      pattern += String.raw`\s` + quantifier(min, max); // bounded on purpose
    } else if (examples.length > 1 && new Set(texts).size === 1) {
      pattern += escape(token.text);
    } else {
      pattern += classFor(token.kind, texts) + quantifier(min, max);
    }
  });

  return pattern;
}

function classFor(kind: string, texts: readonly string[]): string {
  const hasUmlaut = /[ÄÖÜäöüß]/u.test(texts.join(''));

  return (hasUmlaut ? UMLAUT_CLASSES[kind] : undefined) ?? CLASSES[kind] ?? '';
}

function quantifier(min: number, max: number): string {
  if (min === 1 && max === 1) {
    return '';
  }

  return min === max ? `{${String(min)}}` : `{${String(min)},${String(max)}}`;
}

/** A pattern made of letter classes only would match ordinary words. */
function isSpecific(groups: readonly Token[][][]): boolean {
  return groups.every((examples) => {
    const firstExample = examples[0] ?? [];
    const kinds = firstExample.map((t) => t.kind);
    const hasConstant =
      examples.length > 1 &&
      firstExample.some(
        (t, i) => (t.kind === 'U' || t.kind === 'L') && new Set(examples.map((tokens) => tokens[i]?.text)).size === 1,
      );

    return kinds.includes('D') || kinds.includes('P') || hasConstant;
  });
}

/** PHP escapes = ! < > : too, which PatternGrammar then rejects (kept for parity). */
function escape(text: string): string {
  return text.replace(/[.\\+*?[\]^$(){}=!<>|:#~]/gu, '\\$&');
}
