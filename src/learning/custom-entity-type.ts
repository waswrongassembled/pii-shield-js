import { isEntityType } from '../entity-type.js';
import { LearningError } from '../errors.js';
import { codePointLength } from '../internal/pcre.js';
import { BACKTRACK_LIMIT, LearnedPattern } from './learned-pattern.js';
import { patternViolation } from './pattern-grammar.js';

/** Limits of a learned type; lengths count code points (PHP's mb_strlen). */
export const CUSTOM_ENTITY_TYPE_LIMITS = Object.freeze({
  maxDescriptionLength: 300,
  maxExamples: 20,
  maxExampleLength: 100,
  maxPatternLength: 200,
});

/**
 * A learned entity type: a name, a description, examples and optionally a pattern.
 *
 * Validated, frozen data; its JSON form is exactly PHP's `CustomEntityType::toArray()`, so
 * `JSON.stringify(type)` gives the stored shape. Create it with `defineCustomEntityType()` or
 * `customEntityTypeFromJSON()`. Examples are stored, so they must be synthetic or anonymised.
 */
export interface CustomEntityType {
  /** UPPER_SNAKE_CASE, becomes the placeholder name (⟦NAME_1⟧). */
  readonly name: string;
  readonly description: string;
  /** Values that are this type. */
  readonly examples: readonly string[];
  /** Similar values that are not. */
  readonly counterExamples: readonly string[];
  /** Regular expression in PCRE syntax without delimiters (see PatternGrammar), or null for model-only types. */
  readonly pattern: string | null;
}

export interface CustomEntityTypeInit {
  name: string;
  description: string;
  examples: readonly string[];
  counterExamples?: readonly string[];
  pattern?: string | null;
}

const compiledPatterns = new WeakMap<CustomEntityType, LearnedPattern | null>();

/**
 * Validates and freezes a learned type, with PHP's checks and messages.
 *
 * @throws LearningError
 */
export function defineCustomEntityType(init: CustomEntityTypeInit): CustomEntityType {
  const { name, description, examples, counterExamples = [], pattern = null } = init;
  // PHP's pattern has no /u and no D modifier: $ also matches before a final "\n".
  if (!/^[A-Z][A-Z0-9_]{1,39}\n?$/.test(name)) {
    throw new LearningError('The name must be UPPER_SNAKE_CASE, 2 to 40 characters, e.g. INSURANCE_NUMBER.');
  }
  if (isEntityType(name)) {
    throw new LearningError(`"${name}" is a built-in type. Choose another name.`);
  }
  if (examples.length === 0) {
    throw new LearningError('At least one example is needed.');
  }
  // Description and examples reach the detection model: keep them short, single-line data.
  assertSingleLine(description, CUSTOM_ENTITY_TYPE_LIMITS.maxDescriptionLength, 'The description');
  const max = CUSTOM_ENTITY_TYPE_LIMITS.maxExamples;
  if (examples.length > max || counterExamples.length > max) {
    throw new LearningError(`At most ${String(max)} examples and ${String(max)} counter-examples.`);
  }
  for (const example of [...examples, ...counterExamples]) {
    assertSingleLine(example, CUSTOM_ENTITY_TYPE_LIMITS.maxExampleLength, 'An example');
  }

  let compiled: LearnedPattern | null = null;
  if (pattern !== null) {
    compiled = checkPattern(pattern, examples, counterExamples);
  }

  const type: CustomEntityType = Object.freeze({
    name,
    description,
    examples: Object.freeze([...examples]),
    counterExamples: Object.freeze([...counterExamples]),
    pattern,
  });
  compiledPatterns.set(type, compiled);

  return type;
}

/**
 * Builds a type from stored data (JSON file, key-value store) like PHP's `fromArray()`: non-string
 * fields become empty, non-string list entries are dropped, unknown keys are ignored, an empty pattern
 * means model-only. Every field is then validated.
 *
 * @throws LearningError
 */
export function customEntityTypeFromJSON(data: unknown): CustomEntityType {
  const record: Record<string, unknown> = isPhpArray(data) ? (data as Record<string, unknown>) : {};
  const strings = (list: unknown): string[] =>
    isPhpArray(list) ? Object.values(list).filter((v): v is string => typeof v === 'string') : [];
  const { name, description, examples, counterExamples, pattern } = record;

  return defineCustomEntityType({
    name: typeof name === 'string' ? name : '',
    description: typeof description === 'string' ? description : '',
    examples: strings(examples),
    counterExamples: strings(counterExamples),
    pattern: typeof pattern === 'string' && pattern !== '' ? pattern : null,
  });
}

/** The compiled pattern of a type (validating it first if it did not come from defineCustomEntityType()). */
export function compiledPattern(type: CustomEntityType): LearnedPattern | null {
  let compiled = compiledPatterns.get(type);
  if (compiled === undefined) {
    compiled = compiledPatterns.get(defineCustomEntityType(type)) ?? null;
    compiledPatterns.set(type, compiled);
  }

  return compiled;
}

/** JSON objects and arrays are both PHP arrays. */
function isPhpArray(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function assertSingleLine(value: string, maxLength: number, what: string): void {
  // No control characters (one line) and no angle brackets: they could end the model's data block.
  // eslint-disable-next-line no-control-regex -- control characters are what this check is about
  if (codePointLength(value) > maxLength || /[\x00-\x1F\x7F<>]/u.test(value)) {
    throw new LearningError(`${what} must be one line of at most ${String(maxLength)} characters, without < and >.`);
  }
}

function checkPattern(
  pattern: string,
  examples: readonly string[],
  counterExamples: readonly string[],
): LearnedPattern {
  const compiled = LearnedPattern.compile(pattern);
  if (!(compiled instanceof LearnedPattern) && !compiled.compiles) {
    throw new LearningError(`The pattern ${pattern} is not a valid regular expression.`);
  }

  // Patterns run on every text: no constructs that can backtrack catastrophically (ReDoS).
  let reason =
    codePointLength(pattern) > CUSTOM_ENTITY_TYPE_LIMITS.maxPatternLength
      ? `longer than ${String(CUSTOM_ENTITY_TYPE_LIMITS.maxPatternLength)} characters`
      : patternViolation(pattern);
  if (reason === null && !(compiled instanceof LearnedPattern)) {
    // Cannot happen: everything the grammar allows is compiled or rejected as invalid above.
    throw new LearningError(`The pattern ${pattern} is not a valid regular expression.`);
  }
  if (reason === null && compiled instanceof LearnedPattern && !runsInBoundedTime(compiled, examples)) {
    reason = 'it takes too long on adversarial input';
  }
  if (reason !== null || !(compiled instanceof LearnedPattern)) {
    throw new LearningError(`The pattern ${pattern} is not allowed: ${reason ?? ''}.`);
  }

  // Examples are personal data: messages name their position, never the value (they reach HTTP and MCP clients).
  examples.forEach((example, i) => {
    if (!compiled.matchesWhole(example)) {
      throw new LearningError(`The pattern ${pattern} does not match example ${String(i + 1)}.`);
    }
  });
  counterExamples.forEach((counter, i) => {
    if (compiled.matchesWhole(counter)) {
      throw new LearningError(`The pattern ${pattern} also matches counter-example ${String(i + 1)}.`);
    }
  });

  return compiled;
}

/**
 * Second line of defence, as in PHP: the whole-word search must finish on long near-miss inputs within
 * the backtracking budget. Our engine counts like PCRE without its start-up optimisations, so it can be
 * stricter than PHP (docs/DEVIATIONS.md).
 */
function runsInBoundedTime(pattern: LearnedPattern, examples: readonly string[]): boolean {
  const inputs = [
    `${'a'.repeat(5000)}!`,
    `${'A'.repeat(5000)}!`,
    `${'1'.repeat(5000)}!`,
    `${'A1-'.repeat(2000)}!`,
    `${' '.repeat(5000)}x`,
  ];
  for (const example of examples) {
    const times = Math.floor(5000 / Math.max(1, codePointLength(example)));
    inputs.push(`${example.repeat(times)}!`, `${Array.from(example).slice(0, -1).join('').repeat(times)}!`);
  }

  return inputs.every((input) => pattern.searchesWithin(input, BACKTRACK_LIMIT));
}
