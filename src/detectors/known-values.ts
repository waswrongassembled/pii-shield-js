import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { type EntityType, isEntityType } from '../entity-type.js';
import { codePointLength, SPACE, WORD_END, WORD_START } from '../internal/pcre.js';

/** A value the caller already knows to be personal data, e.g. the account holder's name. */
export interface KnownValue {
  readonly value: string;
  readonly type: EntityType;
}

/** The `detector` of entities found from known values; they are exempt from the allowlist. */
export const KNOWN_VALUES_DETECTOR = 'known-values';

const UMLAUTS: Readonly<Record<string, string>> = { ä: 'a', ö: 'o', ü: 'u' };
const SYNTAX = /[\\^$.*+?()[\]{}|/]/gu;
const LIST_MESSAGE = 'knownValues must be a list of { value, type } objects.';

interface Needle {
  readonly pattern: RegExp;
  readonly type: EntityType;
}

/**
 * Finds values the caller passes per call (names of the account holder, their customer numbers, ...)
 * wherever they occur as whole words:
 *
 * - case-insensitive (Unicode), so "MÜLLER" and "müller" match "Müller"
 * - umlauts in either spelling: "Müller" also matches "Mueller" and a decomposed "Müller", and
 *   "Mueller" matches "Müller"; "ß" and "ss" match each other
 * - only whole words: "Ali" does not match in "Alibi" or "Kalium"
 * - any run of whitespace (also a line break) between the words of a value
 *
 * The values are held only by this instance (never stored, learned or logged); validation errors never
 * contain them, and the detector serializes and inspects as `{ name, count }`.
 */
export class KnownValuesDetector implements Detector {
  static readonly MAX_VALUES = 500;
  static readonly MIN_LENGTH = 2;
  static readonly MAX_LENGTH = 200;

  readonly name = KNOWN_VALUES_DETECTOR;
  readonly #needles: readonly Needle[];

  /** @throws TypeError on invalid input; the message never contains a value */
  constructor(values: Iterable<KnownValue>) {
    if (typeof (values as unknown as { [Symbol.iterator]?: unknown } | null)?.[Symbol.iterator] !== 'function') {
      throw new TypeError(LIST_MESSAGE);
    }
    const needles = new Map<string, Needle>();
    let count = 0;
    for (const item of values as Iterable<unknown>) {
      if (++count > KnownValuesDetector.MAX_VALUES) {
        throw new TypeError(`knownValues accepts at most ${String(KnownValuesDetector.MAX_VALUES)} values.`);
      }
      const { value, type } = checked(item);
      const key = `${type}\0${value.toLowerCase()}`;
      if (!needles.has(key)) {
        needles.set(key, { pattern: new RegExp(`${WORD_START}(?:${pattern(value)})${WORD_END}`, 'giu'), type });
      }
    }
    this.#needles = [...needles.values()];
  }

  /** Number of distinct values. */
  get size(): number {
    return this.#needles.length;
  }

  detect(text: string): Entity[] {
    const entities: Entity[] = [];
    for (const { pattern, type } of this.#needles) {
      for (const match of text.matchAll(pattern)) {
        entities.push(
          createEntity({ type, value: match[0], offset: match.index, confidence: 1, detector: KNOWN_VALUES_DETECTOR }),
        );
      }
    }

    return entities;
  }

  toJSON(): { name: string; count: number } {
    return { name: this.name, count: this.size };
  }

  toString(): string {
    return `KnownValuesDetector(${String(this.size)} values)`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

function checked(item: unknown): { value: string; type: EntityType } {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new TypeError(LIST_MESSAGE);
  }
  const { value, type } = item as { value?: unknown; type?: unknown };
  if (typeof value !== 'string') {
    throw new TypeError('Each known value must be a string.');
  }
  if (typeof type !== 'string' || !isEntityType(type)) {
    throw new TypeError('Each known value needs a built-in entity type.');
  }
  const trimmed = value.normalize('NFC').trim();
  const length = codePointLength(trimmed);
  if (length < KnownValuesDetector.MIN_LENGTH) {
    throw new TypeError(`Known values must be at least ${String(KnownValuesDetector.MIN_LENGTH)} characters long.`);
  }
  if (length > KnownValuesDetector.MAX_LENGTH) {
    throw new TypeError(`Known values must be at most ${String(KnownValuesDetector.MAX_LENGTH)} characters long.`);
  }

  return { value: trimmed, type };
}

/** Regex source for one value: literal characters, spelling variants of umlauts and ß, flexible whitespace. */
function pattern(value: string): string {
  return value
    .split(new RegExp(`${SPACE}+`, 'u'))
    .map((word) => {
      const chars = Array.from(word);
      let source = '';
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i] ?? '';
        const lower = char.toLowerCase();
        const next = (chars[i + 1] ?? '').toLowerCase();
        const base = UMLAUTS[lower];
        if (base !== undefined) {
          source += umlaut(base);
        } else if (next === 'e' && (lower === 'a' || lower === 'o' || lower === 'u')) {
          source += umlaut(lower);
          i++;
        } else if (lower === 'ß' || (lower === 's' && next === 's')) {
          source += '(?:ss|ß)';
          i += lower === 's' ? 1 : 0;
        } else {
          source += char.replace(SYNTAX, '\\$&');
        }
      }

      return source;
    })
    .join(`${SPACE}+`);
}

/** "ü", "u" + combining diaeresis or "ue" (case-insensitive through the flags). */
function umlaut(base: string): string {
  const composed = `${base}̈`.normalize('NFC');

  return `(?:${composed}|${base}\\u0308|${base}e)`;
}
