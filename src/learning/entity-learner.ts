import type { Detector } from '../detector.js';
import { LearningError } from '../errors.js';
import { phpTrim } from '../internal/pcre.js';
import { LearnedTypesDetector } from './custom-entity-detector.js';
import {
  type CustomEntityType,
  type CustomEntityTypeInit,
  defineCustomEntityType,
  withoutExamples,
} from './custom-entity-type.js';
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
  /**
   * Store examples and counter-examples with the type. Default true (PHP's behaviour and file format).
   *
   * With false, learn() checks the pattern against the examples and then stores only name, description
   * and pattern (data minimisation: examples may be personal data). Consequences: types without a pattern
   * (plain words, model-only) are refused, because only the examples let the model find them; the model
   * knows the other types by name and description only; a stored type cannot be re-derived from its
   * examples later; PHP cannot read a store that holds such types. Types stored before keep their
   * examples until dropExamples().
   */
  keepExamples?: boolean;
}

/** Result of EntityLearner.dropExamples(): type names only. */
export interface DropExamplesResult {
  /** Types whose examples were removed. */
  readonly stripped: readonly string[];
  /** Model-only types: they keep their examples, without them nothing would find them. */
  readonly kept: readonly string[];
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
  readonly #keepExamples: boolean;
  #snapshot: readonly CustomEntityType[] = [];
  #detector: Detector | undefined;

  constructor(options: EntityLearnerOptions) {
    this.#store = options.store;
    this.#learnPattern = options.learnPattern ?? learnPattern;
    this.#keepExamples = options.keepExamples ?? true;
  }

  /** Whether learn() stores examples and counter-examples (option `keepExamples`). */
  get keepExamples(): boolean {
    return this.#keepExamples;
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
   * Same as learn(), without saving: for trying out examples. The type is what learn() would store
   * (without examples if `keepExamples` is false).
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

    // Validated with the examples (the pattern must match them) before they are dropped.
    const type = defineCustomEntityType({ ...init, counterExamples, pattern });
    if (this.#keepExamples) {
      return Object.freeze({ type, note });
    }
    if (type.pattern === null) {
      throw new LearningError(
        'These examples give no pattern, and this learner does not keep examples, which model-based detection would need to find the type. Enter a pattern by hand.',
      );
    }

    return Object.freeze({ type: withoutExamples(type), note });
  }

  async forget(name: string): Promise<void> {
    await this.#store.remove(name);
    await this.refresh();
  }

  /**
   * Removes the examples and counter-examples of every stored type that has a pattern (e.g. after
   * switching to `keepExamples: false`). Model-only types keep theirs. Run it as a one-off migration:
   * a type another process learns at the same time can be overwritten with its older version.
   */
  async dropExamples(): Promise<DropExamplesResult> {
    const stripped: string[] = [];
    const kept: string[] = [];
    for (const type of await this.#store.all()) {
      if (type.examples.length === 0 && type.counterExamples.length === 0) {
        continue;
      }
      if (type.pattern === null) {
        kept.push(type.name);
        continue;
      }
      await this.#store.save(withoutExamples(type));
      stripped.push(type.name);
    }
    await this.refresh();

    return Object.freeze({ stripped: Object.freeze(stripped), kept: Object.freeze(kept) });
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

  /**
   * A detector for all learned patterns; picks up the snapshot at each call, so later learn() calls take
   * effect. Always the same instance, so `new PiiShield({ learner })` can tell when it is already among
   * the detectors.
   */
  detector(): Detector {
    this.#detector ??= new LearnedTypesDetector(() => this.#snapshot);

    return this.#detector;
  }
}
