import type { Detector } from '../detector.js';
import { LearningError } from '../errors.js';
import { phpTrim } from '../internal/pcre.js';
import { LearnedTypesDetector } from './custom-entity-detector.js';
import { type CustomEntityType, type CustomEntityTypeInit, defineCustomEntityType } from './custom-entity-type.js';
import { learnPattern } from './pattern-learner.js';
import type { CustomEntityStore } from './store.js';

export interface LearningResult {
  readonly type: CustomEntityType;
  /** Why the type has no pattern (model-only), or null. */
  readonly note: string | null;
}

export interface EntityLearnerOptions {
  store: CustomEntityStore;
  /** Derives a pattern from examples; default learnPattern(). */
  learnPattern?: (examples: readonly string[], counterExamples: readonly string[]) => string;
}

const MODEL_ONLY_NOTE =
  'No pattern: plain words would match ordinary text. Only model-based detection finds this type.';

/**
 * Teach pii-shield new entity types from examples ("mask things like this too").
 *
 * A pattern is derived from the examples unless one is given. Values without a structure (plain words
 * such as pet names) cannot become a safe pattern; they are learned as model-only types.
 *
 * Detection is synchronous, the store is not: the learner keeps a snapshot of the stored types. It is
 * updated by learn() and forget() and reloaded by refresh(); `EntityLearner.create()` loads it once.
 * Call refresh() (e.g. on a timer) to pick up types other processes learned.
 */
export class EntityLearner {
  readonly #store: CustomEntityStore;
  readonly #learnPattern: NonNullable<EntityLearnerOptions['learnPattern']>;
  #snapshot: readonly CustomEntityType[] = [];

  constructor(options: EntityLearnerOptions) {
    this.#store = options.store;
    this.#learnPattern = options.learnPattern ?? learnPattern;
  }

  /** A learner whose snapshot is already loaded from the store. */
  static async create(options: EntityLearnerOptions): Promise<EntityLearner> {
    const learner = new EntityLearner(options);
    await learner.refresh();

    return learner;
  }

  /**
   * Learns and saves the type (replacing one with the same name).
   *
   * @throws LearningError
   */
  async learn(init: CustomEntityTypeInit): Promise<LearningResult> {
    const result = this.preview(init);
    await this.#store.save(result.type);
    await this.refresh();

    return result;
  }

  /**
   * Same as learn(), without saving: for trying out examples.
   *
   * @throws LearningError
   */
  preview(init: CustomEntityTypeInit): LearningResult {
    const { examples, counterExamples = [] } = init;
    let { pattern = null } = init;
    let note: string | null = null;
    if (pattern === null || phpTrim(pattern) === '') {
      try {
        pattern = this.#learnPattern(examples, counterExamples);
      } catch (e) {
        if (!(e instanceof LearningError) || e.code !== 'LEARNING_PLAIN_WORDS') {
          throw e;
        }
        pattern = null;
        note = MODEL_ONLY_NOTE;
      }
    }

    return Object.freeze({ type: defineCustomEntityType({ ...init, counterExamples, pattern }), note });
  }

  async forget(name: string): Promise<void> {
    await this.#store.remove(name);
    await this.refresh();
  }

  /** All stored types, sorted by name (read from the store, also refreshing the snapshot). */
  async types(): Promise<CustomEntityType[]> {
    const types = await this.#store.all();
    this.#snapshot = Object.freeze([...types]);

    return types;
  }

  /** Reloads the snapshot the detector uses. */
  async refresh(): Promise<void> {
    await this.types();
  }

  /** The types in the current snapshot. */
  get snapshot(): readonly CustomEntityType[] {
    return this.#snapshot;
  }

  /** A detector for all learned patterns; picks up the snapshot at each call, so later learn() calls take effect. */
  detector(): Detector {
    return new LearnedTypesDetector(() => this.#snapshot);
  }
}
