import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { PiiShieldError } from '../errors.js';
import { compiledPattern, type CustomEntityType } from './custom-entity-type.js';
import { BacktrackLimitExceeded } from './learned-pattern.js';

const CONFIDENCE = 0.75;

/**
 * Finds a learned type by its pattern, as a whole word (not preceded or followed by a letter or number).
 * Types without a pattern are left to the model detector.
 *
 * Like PHP, every search has a backtracking budget; exceeding it throws (fail closed) instead of
 * hanging or returning partial results.
 */
export class CustomEntityDetector implements Detector {
  readonly name = 'custom';
  readonly #type: CustomEntityType;

  constructor(type: CustomEntityType) {
    // Validates types that did not come from defineCustomEntityType().
    compiledPattern(type);
    this.#type = type;
  }

  detect(text: string): Entity[] {
    const pattern = compiledPattern(this.#type);
    if (pattern === null) {
      return [];
    }
    let matches;
    try {
      matches = pattern.matchAll(text);
    } catch (e) {
      if (e instanceof BacktrackLimitExceeded) {
        throw new PiiShieldError('Regex failed: Backtrack limit exhausted', 'DETECTION_BACKTRACK_LIMIT');
      }
      throw e;
    }

    return matches.map(({ value, offset }) =>
      createEntity({
        type: EntityType.Other,
        value,
        offset,
        confidence: CONFIDENCE,
        detector: 'custom',
        label: this.#type.name,
      }),
    );
  }
}

/**
 * Runs the patterns of all types `source` returns at the time of each call, so types learned later
 * take effect on the next text. See EntityLearner.detector().
 */
export class LearnedTypesDetector implements Detector {
  readonly name = 'learned-types';
  readonly #source: () => Iterable<CustomEntityType>;
  readonly #detectors = new WeakMap<CustomEntityType, CustomEntityDetector>();

  constructor(source: Iterable<CustomEntityType> | (() => Iterable<CustomEntityType>)) {
    this.#source = typeof source === 'function' ? source : () => source;
  }

  detect(text: string): Entity[] {
    const entities: Entity[] = [];
    for (const type of this.#source()) {
      let detector = this.#detectors.get(type);
      if (detector === undefined) {
        detector = new CustomEntityDetector(type);
        this.#detectors.set(type, detector);
      }
      entities.push(...detector.detect(text));
    }

    return entities;
  }
}
