import {
  type AsyncDetector,
  type DetectOptions,
  type Detector,
  type DetectorFunction,
  isAsyncDetector,
} from './detector.js';
import { AtSvnrDetector } from './detectors/at-svnr.js';
import { BirthDateDetector } from './detectors/birth-date.js';
import { EmailDetector } from './detectors/email.js';
import { FileNumberDetector } from './detectors/file-number.js';
import { IbanDetector } from './detectors/iban.js';
import { LicensePlateDetector } from './detectors/license-plate.js';
import { PhoneDetector } from './detectors/phone.js';
import { PostalAddressDetector } from './detectors/postal-address.js';
import { SalutationPersonDetector } from './detectors/salutation-person.js';
import { TaxNumberDetector } from './detectors/tax-number.js';
import { createEntity, type Entity, typeName } from './entity.js';
import { EntityType } from './entity-type.js';
import { codePointLength, phpTrim, SPACE } from './internal/pcre.js';

const MIN_PROPAGATION_LENGTH = 3;

/**
 * Surnames are only derived from confidently detected full names; an uncertain
 * "Herr Muster Bescheid" must not turn every "Bescheid" into a person.
 */
const SURNAME_PROPAGATION_MIN_CONFIDENCE = 0.8;

export interface EntityExtractorOptions {
  /**
   * Detectors to run; defaults to defaultDetectors(). Async detectors (e.g. ModelDetector) only work
   * with the async APIs (extractAsync(), redactAsync(), redactToVault(), maskAsync()).
   */
  detectors?: Iterable<Detector | DetectorFunction | AsyncDetector>;
  /** Values that are never treated as PII (exact match). */
  allowlist?: Iterable<string>;
}

/**
 * Offline, regex- and checksum-based detectors for all entity types.
 */
export function defaultDetectors(): Detector[] {
  return [
    new AtSvnrDetector(),
    new IbanDetector(),
    new TaxNumberDetector(),
    new EmailDetector(),
    new PhoneDetector(),
    new BirthDateDetector(),
    new FileNumberDetector(),
    new LicensePlateDetector(),
    new SalutationPersonDetector(),
    new PostalAddressDetector(),
  ];
}

/**
 * Last word of a multi-word name, or null for single-word values.
 */
export function surname(name: string): string | null {
  const parts = phpTrim(name).split(SPLIT_WORDS);

  return parts.length > 1 ? (parts.at(-1) ?? null) : null;
}

const SPLIT_WORDS = new RegExp(`${SPACE}+`, 'u');
const NORMALIZE = /\r\n?|[\u{A0}\u{2007}\u{2009}\u{202F}]/gu;
const WORDS = /[\p{L}\p{N}]+/gu;
const FIRST_WORD = /[\p{L}\p{N}]+/u;
const NOT_AFTER_WORD = /(?<![\p{L}\p{N}])/uy;
const NOT_BEFORE_WORD = /(?![\p{L}\p{N}])/uy;

/**
 * Runs all detectors and returns a clean, non-overlapping list of entities.
 *
 * - Overlaps: the longer span wins; on equal length the higher confidence wins.
 * - Propagation: every further whole-word occurrence of a detected value is an entity too,
 *   even where no detector would have found it on its own (e.g. a file number repeated without keyword).
 * - Surnames of confidently detected full names are propagated as well.
 * - Line endings and spaces: detectors see "\r\n" as " \n", a lone "\r" as "\n" and no-break or thin
 *   spaces as " ". The replacement keeps the length, so offsets and values refer to the
 *   original text and restore gives back the original characters.
 */
export class EntityExtractor {
  readonly #detectors: readonly (Detector | DetectorFunction | AsyncDetector)[];
  readonly #allowlist: ReadonlySet<string>;

  constructor(options: EntityExtractorOptions = {}) {
    this.#detectors = [...(options.detectors ?? defaultDetectors())];
    this.#allowlist = new Set(options.allowlist);
  }

  /** Whether a detector needs the async APIs. */
  get isAsync(): boolean {
    return this.#detectors.some(isAsyncDetector);
  }

  /**
   * Non-overlapping entities, sorted by offset.
   *
   * @throws TypeError when an async detector is configured (nothing is sent then); use extractAsync()
   */
  extract(text: string): Entity[] {
    const asyncDetector = this.#detectors.find(isAsyncDetector);
    if (asyncDetector !== undefined) {
      throw new TypeError(
        `The detector "${asyncDetector.name ?? 'async'}" is async. Use extractAsync(), redactAsync(), redactToVault() or maskAsync().`,
      );
    }
    const normalized = normalize(text);
    const detected: Entity[] = [];
    for (const detector of this.#detectors as readonly (Detector | DetectorFunction)[]) {
      const found = typeof detector === 'function' ? detector(normalized) : detector.detect(normalized);
      if (isPromiseLike(found)) {
        // A function returning a Promise cannot be told apart up front; its findings would be lost.
        Promise.resolve(found).catch(() => undefined);
        throw new TypeError(
          'A detector returned a Promise. Implement AsyncDetector (async: true) and use extractAsync().',
        );
      }
      for (const entity of found) {
        detected.push(entity);
      }
    }

    return this.#resolve(text, normalized, detected);
  }

  /**
   * Like extract(), with async detectors: they run concurrently, after the synchronous ones. Results are
   * the same as extract() for the same findings.
   */
  async extractAsync(text: string, options: DetectOptions = {}): Promise<Entity[]> {
    options.signal?.throwIfAborted();
    const normalized = normalize(text);
    // Synchronous detectors first: if one throws, nothing has been sent to an async one yet.
    const results: Promise<readonly Entity[]>[] = this.#detectors.map((detector) => {
      if (isAsyncDetector(detector)) {
        return Promise.resolve([]);
      }

      return Promise.resolve(typeof detector === 'function' ? detector(normalized) : detector.detect(normalized));
    });
    this.#detectors.forEach((detector, i) => {
      if (isAsyncDetector(detector)) {
        results[i] = detector.detect(normalized, options);
      }
    });
    const detected: Entity[] = [];
    for (const found of await Promise.all(results)) {
      for (const entity of found) {
        detected.push(entity);
      }
    }

    return this.#resolve(text, normalized, detected);
  }

  #resolve(text: string, normalized: string, detected: Entity[]): Entity[] {
    // Filter before propagation (an allowed value must not seed surnames) and after it.
    let entities = resolveOverlaps(this.#withoutAllowed(detected));
    entities = resolveOverlaps(this.#withoutAllowed([...entities, ...propagate(normalized, entities)]));

    return normalized === text ? entities : withOriginalValues(text, entities);
  }

  #withoutAllowed(entities: Entity[]): Entity[] {
    return this.#allowlist.size === 0 ? entities : entities.filter((e) => !this.#allowlist.has(e.value));
  }
}

/** Replaces characters that break line- and space-based patterns, one UTF-16 unit for one. */
function normalize(text: string): string {
  return text.replace(NORMALIZE, (m) => (m === '\r\n' ? ' \n' : m === '\r' ? '\n' : ' '));
}

/** The same spans with the characters of the original text. */
function withOriginalValues(text: string, entities: Entity[]): Entity[] {
  return entities.map((e) => {
    const value = text.slice(e.offset, e.offset + e.value.length);

    return value === e.value ? e : { ...e, value };
  });
}

/**
 * Greedy: take spans by length (desc), then confidence (desc), then offset, skip anything overlapping.
 * Length counts code points, as in PHP, so the order is the same for values with characters outside the BMP.
 */
function resolveOverlaps(entities: Entity[]): Entity[] {
  const ranked = entities
    .map((entity) => ({ entity, length: codePointLength(entity.value) }))
    .sort(
      (a, b) => b.length - a.length || b.entity.confidence - a.entity.confidence || a.entity.offset - b.entity.offset,
    );

  const kept: Entity[] = [];
  const covered = new Set<number>();
  for (const { entity } of ranked) {
    const end = entity.offset + entity.value.length;
    let free = true;
    for (let i = entity.offset; i < end && free; i++) {
      free = !covered.has(i);
    }
    if (!free) {
      continue;
    }
    for (let i = entity.offset; i < end; i++) {
      covered.add(i);
    }
    kept.push(entity);
  }

  return kept.sort((a, b) => a.offset - b.offset);
}

interface Needle {
  readonly type: EntityType;
  readonly value: string;
  readonly label: string | undefined;
}

/**
 * Every whole-word occurrence of a detected value (and of the surname of a confident full name).
 *
 * One pass over the text instead of one regex per value. Values are indexed by their first word,
 * then by the position of that word in the value and by length; at each word of the text,
 * the substring of that length is looked up. Cost per word: number of distinct lengths.
 */
function propagate(text: string, entities: Entity[]): Entity[] {
  const needles = new Map<string, Needle>();
  for (const entity of entities) {
    needles.set(`${typeName(entity)}\0${entity.value}`, {
      type: entity.type,
      value: entity.value,
      label: entity.label,
    });
    if (entity.type === EntityType.Person && entity.confidence >= SURNAME_PROPAGATION_MIN_CONFIDENCE) {
      const last = surname(entity.value);
      if (last !== null) {
        needles.set(`${typeName(entity)}\0${last}`, { type: entity.type, value: last, label: entity.label });
      }
    }
  }

  // first word → its position in the value → value length → value → needles
  const index = new Map<string, Map<number, Map<number, Map<string, Needle[]>>>>();
  for (const needle of needles.values()) {
    const first = codePointLength(needle.value) < MIN_PROPAGATION_LENGTH ? null : FIRST_WORD.exec(needle.value);
    if (first === null) {
      continue;
    }
    const byPrefix = getOrSet(index, first[0], () => new Map<number, Map<number, Map<string, Needle[]>>>());
    const byLength = getOrSet(byPrefix, first.index, () => new Map<number, Map<string, Needle[]>>());
    const byValue = getOrSet(byLength, needle.value.length, () => new Map<string, Needle[]>());
    getOrSet(byValue, needle.value, () => []).push(needle);
  }
  if (index.size === 0) {
    return [];
  }

  const hits: [number, Needle][] = [];
  for (const word of text.matchAll(WORDS)) {
    for (const [prefix, byLength] of index.get(word[0]) ?? []) {
      const start = word.index - prefix;
      if (start < 0) {
        continue;
      }
      for (const [length, byValue] of byLength) {
        const candidates = byValue.get(text.slice(start, start + length));
        if (candidates !== undefined && isWordBoundary(text, start, start + length)) {
          for (const needle of candidates) {
            hits.push([start, needle]);
          }
        }
      }
    }
  }

  return hits
    .sort((a, b) => a[0] - b[0])
    .map(([offset, { type, value, label }]) =>
      createEntity({ type, value, offset, confidence: 0.5, detector: 'propagation', label }),
    );
}

function isWordBoundary(text: string, start: number, end: number): boolean {
  NOT_AFTER_WORD.lastIndex = start;
  NOT_BEFORE_WORD.lastIndex = end;

  return NOT_AFTER_WORD.test(text) && NOT_BEFORE_WORD.test(text);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

function getOrSet<K, V>(map: Map<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }

  return value;
}
