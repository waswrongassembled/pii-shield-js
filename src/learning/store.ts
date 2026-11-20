import { PiiShieldError } from '../errors.js';
import { type CustomEntityType, customEntityTypeFromJSON } from './custom-entity-type.js';

/**
 * Where learned entity types live. Default: JsonFileCustomEntityStore; any key-value backend
 * (Redis, a database) via KeyValueCustomEntityStore.
 */
export interface CustomEntityStore {
  /** Sorted by name. */
  all(): Promise<CustomEntityType[]>;
  get(name: string): Promise<CustomEntityType | null>;
  /** Adds the type or replaces the one with the same name. */
  save(type: CustomEntityType): Promise<void>;
  remove(name: string): Promise<void>;
}

/** Sorted by name with PHP's strcmp() (byte order; names are ASCII). Stable, like PHP 8's usort(). */
export function sortByName(types: CustomEntityType[]): CustomEntityType[] {
  return types.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Types from decoded stored data: every JSON array or object entry is validated, other entries are skipped. */
export function typesFromJSON(data: unknown): CustomEntityType[] {
  const entries = typeof data === 'object' && data !== null ? Object.values(data) : [];

  return sortByName(
    entries.filter((e): e is object => typeof e === 'object' && e !== null).map((e) => customEntityTypeFromJSON(e)),
  );
}

/** Learned types in memory, e.g. for tests or a single process that learns at start-up. */
export class InMemoryCustomEntityStore implements CustomEntityStore {
  readonly #types = new Map<string, CustomEntityType>();

  constructor(types: Iterable<CustomEntityType> = []) {
    for (const type of types) {
      this.#types.set(type.name, type);
    }
  }

  all(): Promise<CustomEntityType[]> {
    return Promise.resolve(sortByName([...this.#types.values()]));
  }

  get(name: string): Promise<CustomEntityType | null> {
    return Promise.resolve(this.#types.get(name) ?? null);
  }

  save(type: CustomEntityType): Promise<void> {
    this.#types.delete(type.name);
    this.#types.set(type.name, type);

    return Promise.resolve();
  }

  remove(name: string): Promise<void> {
    this.#types.delete(name);

    return Promise.resolve();
  }
}

/** The minimal string key-value API KeyValueCustomEntityStore needs (Redis, Valkey, a database table, ...). */
export interface KeyValueStore {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

export interface KeyValueCustomEntityStoreOptions {
  /** Default "pii_shield.learned_types", PHP's CacheCustomEntityStore key. */
  key?: string;
}

/**
 * Learned types in a key-value store, as one JSON list under one key without expiry (port of PHP's
 * CacheCustomEntityStore). The value is the same JSON shape as the file store, not PHP's PSR-6
 * serialisation, so PHP and Node cannot share the key (docs/DEVIATIONS.md).
 *
 * save() and remove() read, change and write the whole list: serialise writers across processes
 * yourself (e.g. a Redis lock); writes through one instance are serialised.
 */
export class KeyValueCustomEntityStore implements CustomEntityStore {
  readonly #kv: KeyValueStore;
  readonly #key: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(kv: KeyValueStore, options: KeyValueCustomEntityStoreOptions = {}) {
    this.#kv = kv;
    this.#key = options.key ?? 'pii_shield.learned_types';
  }

  async all(): Promise<CustomEntityType[]> {
    const raw = await this.#kv.get(this.#key);
    if (raw === null || raw === undefined) {
      return [];
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // No cause: V8's JSON.parse() message quotes the stored text, which holds examples.
      throw new PiiShieldError(
        `The key "${this.#key}" does not contain a list of learned types.`,
        'LEARNING_STORE_CORRUPT',
      );
    }

    // PHP ignores a non-array value here.
    return typesFromJSON(data);
  }

  async get(name: string): Promise<CustomEntityType | null> {
    return (await this.all()).find((t) => t.name === name) ?? null;
  }

  save(type: CustomEntityType): Promise<void> {
    return this.#write((types) => [...types.filter((t) => t.name !== type.name), type]);
  }

  remove(name: string): Promise<void> {
    return this.#write((types) => types.filter((t) => t.name !== name));
  }

  #write(change: (types: CustomEntityType[]) => CustomEntityType[]): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#kv.set(this.#key, JSON.stringify(change(await this.all())));
    });
    this.#queue = run.catch(() => undefined);

    return run;
  }
}
