import type { DetectOptions } from './detector.js';
import { type Entity, typeName } from './entity.js';
import { EntityExtractor, type EntityExtractorOptions } from './entity-extractor.js';
import { EntityType } from './entity-type.js';
import { replaceSpans } from './internal/text-spans.js';
import { PartialMask } from './masking/partial-mask.js';
import type { Masker, MaskingFunction, MaskingStrategy } from './masking/strategy.js';
import { TypeLabelMask } from './masking/type-label-mask.js';

export interface PiiMaskerOptions extends EntityExtractorOptions {
  /** Keyed by EntityType value or learned type name; merged over defaultMaskingStrategies(). */
  strategies?: Readonly<Record<string, MaskingStrategy | MaskingFunction | undefined>>;
  /** For types without a strategy; default `new TypeLabelMask()`. */
  fallback?: MaskingStrategy | MaskingFunction;
}

/** IBAN keeps first and last 4 characters, phone keeps the last 2. */
export function defaultMaskingStrategies(): Record<string, MaskingStrategy> {
  return {
    [EntityType.Iban]: new PartialMask({ keepStart: 4, keepEnd: 4 }),
    [EntityType.Phone]: new PartialMask({ keepEnd: 2 }),
  };
}

/**
 * Same detection as PiiShield, but replaces entities irreversibly. No mapping, no way back.
 *
 * A strategy is looked up by the entity's type name (learned types), then by its type; everything else
 * goes to the fallback, which turns it into a type label.
 */
export class PiiMasker implements Masker {
  readonly #extractor: EntityExtractor;
  readonly #strategies: ReadonlyMap<string, MaskingFunction>;
  readonly #fallback: MaskingFunction;

  constructor(options: PiiMaskerOptions = {}) {
    const { detectors, allowlist, knownValues, learner, strategies = {}, fallback = new TypeLabelMask() } = options;
    this.#extractor = new EntityExtractor({
      ...(detectors === undefined ? {} : { detectors }),
      ...(allowlist === undefined ? {} : { allowlist }),
      ...(knownValues === undefined ? {} : { knownValues }),
      ...(learner === undefined ? {} : { learner }),
    });
    const merged = new Map<string, MaskingFunction>();
    for (const [type, strategy] of [...Object.entries(defaultMaskingStrategies()), ...Object.entries(strategies)]) {
      if (strategy !== undefined) {
        merged.set(type, toFunction(strategy));
      }
    }
    this.#strategies = merged;
    this.#fallback = toFunction(fallback);
  }

  /**
   * @throws TypeError when an async detector (e.g. ModelDetector) is configured; use maskAsync()
   */
  mask(text: string): string {
    return replaceSpans(text, this.#extractor.extract(text), (entity) => this.#strategyFor(entity)(entity));
  }

  /** Like mask(), and works with async detectors such as ModelDetector. */
  async maskAsync(text: string, options: DetectOptions = {}): Promise<string> {
    const entities = await this.#extractor.extractAsync(text, options);

    return replaceSpans(text, entities, (entity) => this.#strategyFor(entity)(entity));
  }

  #strategyFor(entity: Entity): MaskingFunction {
    return this.#strategies.get(typeName(entity)) ?? this.#strategies.get(entity.type) ?? this.#fallback;
  }
}

function toFunction(strategy: MaskingStrategy | MaskingFunction): MaskingFunction {
  return typeof strategy === 'function' ? strategy : (entity) => strategy.mask(entity);
}
