import {
  DEFAULT_PURGE_INTERVAL,
  MAX_PURGE_INTERVAL,
  type PurgeSchedule,
  reportToStderr,
  schedulePurge,
} from './internal/background.js';
import { EntityLearner } from './learning/entity-learner.js';
import { type CustomEntityStore, InMemoryCustomEntityStore } from './learning/store.js';
import { PiiShield, type PiiShieldOptions } from './pii-shield.js';
import { EncryptedVault, generateVaultKey } from './vault/encrypted-vault.js';
import { MemoryVaultStorage } from './vault/memory-vault-storage.js';
import { assertTtl, type Vault, type VaultStorage } from './vault/vault.js';

/**
 * Seconds a mapping lives unless configured: as the HTTP service. Long enough for a model's answer (also a
 * slow, streamed one), short enough that a leaked vault id or a copy of the storage is soon worthless.
 */
const DEFAULT_VAULT_TTL = 900;

/**
 * A vault backend for createPiiShield(): where the ciphertext goes and the keys that encrypt it.
 * `postgresVault()` (`/postgres`) and `redisVault()` (`/vault-redis`) build one; any VaultStorage works.
 */
export interface VaultSetup {
  /** Receives ciphertext only (createPiiShield() puts an EncryptedVault in front of it). */
  storage: VaultStorage;
  /**
   * 32 raw bytes, e.g. `vaultKeyFromEnv()`. Required: a key generated at run time could not read the
   * entries after a restart or in another process. The vault keeps its own copy.
   */
  key: Uint8Array;
  /** Keys of earlier rotations, only for reading (see EncryptedVault), e.g. `previousVaultKeysFromEnv()`. */
  previousKeys?: readonly Uint8Array[] | undefined;
  /**
   * Deletes expired entries; createPiiShield() runs it on a timer. Default: the storage's own
   * `purgeExpired()` if it has one (PostgresVaultStorage, MemoryVaultStorage). Redis expires entries
   * itself and needs none. `false`: never (delete them yourself, e.g. with pg_cron).
   */
  purge?: (() => Promise<unknown>) | false | undefined;
}

/** Background work of createPiiShield(); its errors go to `onError`. */
export type BackgroundTask = 'vault-purge';

export interface CreatePiiShieldOptions extends Omit<PiiShieldOptions, 'vault' | 'learner' | 'vaultTtl'> {
  /**
   * Where mappings are kept between redactToVault() and restoreFromVault():
   * - omitted: in memory with a random key per process. Mappings are lost on restart and not shared
   *   between processes (see `notes`). Fine for a single process; use a persistent store otherwise.
   * - a VaultSetup (`postgresVault()`, `redisVault()`, `{ storage, key }`): encrypted with your key.
   * - a ready Vault (e.g. an EncryptedVault you built): used as is, nothing is purged.
   * - `false`: no vault; redact() and restore() work, the vault methods throw.
   */
  vault?: VaultSetup | Vault | false | undefined;
  /**
   * Store of learned entity types, or a ready EntityLearner. Default: in memory (lost on restart).
   * Detection includes them (PiiShield's `learner` option); teach types with `shield.learner.learn()`.
   */
  learnedTypes?: CustomEntityStore | EntityLearner | undefined;
  /**
   * Store examples and counter-examples with learned types. Default **false** (data minimisation:
   * examples may be personal data); only name, description and pattern are stored. Types without a
   * pattern (model-only, e.g. plain words) are then refused: give a pattern by hand. Not allowed together
   * with a ready EntityLearner, which has its own setting.
   */
  keepExamples?: boolean | undefined;
  /** Seconds a stored mapping lives. Default 900 (15 minutes; PiiShield's own default is 3600). */
  vaultTtl?: number | undefined;
  /**
   * Seconds between purges of expired vault entries (also one at start). Default 300, at most 86400;
   * `0` turns the timer off. The timer is unref'd; close() stops it.
   */
  purgeInterval?: number | undefined;
  /**
   * Errors of background work (the vault purge). Default: one line to stderr with the error's name and
   * code, never its message (a driver error can quote values). Do the same in your own handler.
   */
  onError?: ((error: unknown, task: BackgroundTask) => void) | undefined;
}

/** What createPiiShield() returns: a PiiShield plus its learner and background work. */
export interface ManagedPiiShield extends PiiShield, AsyncDisposable {
  /** The learner whose types detection includes; `learn()` and `forget()` apply at once. */
  readonly learner: EntityLearner;
  /** Notes for the operator (e.g. that the vault is in memory). Never secrets or values; log them at start. */
  readonly notes: readonly string[];
  /**
   * Stops background work (the purge timer) and waits for a running purge. Connections you passed in
   * (pool, Redis client) stay yours to close, after this. Idempotent; also `await using`.
   */
  close(): Promise<void>;
}

/**
 * A PiiShield with safe defaults in one call: an encrypted vault with a short TTL whose expired entries
 * are purged on a timer, learned types included in detection and stored without examples.
 *
 * ```ts
 * const shield = await createPiiShield({
 *   vault: postgresVault({ query: pool.query.bind(pool), key: vaultKeyFromEnv() }),
 *   learnedTypes: new PostgresCustomEntityStore({ query: pool.query.bind(pool) }),
 * });
 * ```
 *
 * At start it reads the vault storage and the learned types once, so a missing table or a wrong
 * connection fails here, not in the first request (the store's error, unchanged).
 *
 * @throws TypeError or RangeError for invalid options (no key for a vault, a bad interval)
 */
export async function createPiiShield(options: CreatePiiShieldOptions = {}): Promise<ManagedPiiShield> {
  const {
    vault: vaultOption,
    learnedTypes,
    keepExamples,
    vaultTtl = DEFAULT_VAULT_TTL,
    purgeInterval = DEFAULT_PURGE_INTERVAL,
    onError = reportToStderr,
    ...shieldOptions
  } = options;
  assertTtl(vaultTtl, 'The vault TTL must be positive.');
  if (!Number.isSafeInteger(purgeInterval) || purgeInterval < 0 || purgeInterval > MAX_PURGE_INTERVAL) {
    throw new RangeError(`The purge interval must be an integer from 0 to ${String(MAX_PURGE_INTERVAL)} seconds.`);
  }
  if (learnedTypes instanceof EntityLearner && keepExamples !== undefined) {
    throw new TypeError('keepExamples is a setting of the EntityLearner: pass it there, or pass a store.');
  }
  const notes: string[] = [];

  const { vault, purge } = buildVault(vaultOption, notes);
  if (vault !== undefined) {
    // Fail at start: no connection, no table, no rights. An id that never exists (ids are hashed).
    await vault.fetch('pii-shield-startup-check');
  }

  const learner =
    learnedTypes instanceof EntityLearner
      ? learnedTypes
      : await EntityLearner.create({
          store: learnedTypes ?? new InMemoryCustomEntityStore(),
          keepExamples: keepExamples ?? false,
        });
  if (learnedTypes === undefined) {
    notes.push('Learned types: in memory; they are lost on restart.');
  }
  if (!learner.keepExamples && learner.snapshot.some((t) => t.pattern !== null && t.examples.length > 0)) {
    notes.push('Learned types: types learned before still hold examples; learner.dropExamples() removes them.');
  }

  let schedule: PurgeSchedule | undefined;
  if (purge !== undefined && purgeInterval > 0) {
    schedule = schedulePurge(purge, purgeInterval, (error) => {
      onError(error, 'vault-purge');
    });
  } else if (purge !== undefined) {
    notes.push('Vault: expired entries are not purged (purgeInterval 0); delete them yourself.');
  }

  return new ManagedShield(
    { ...shieldOptions, ...(vault === undefined ? {} : { vault }), vaultTtl, learner },
    learner,
    Object.freeze(notes),
    schedule,
  );
}

class ManagedShield extends PiiShield implements ManagedPiiShield {
  readonly learner: EntityLearner;
  readonly notes: readonly string[];
  readonly #schedule: PurgeSchedule | undefined;

  constructor(
    options: PiiShieldOptions,
    learner: EntityLearner,
    notes: readonly string[],
    schedule: PurgeSchedule | undefined,
  ) {
    super(options);
    this.learner = learner;
    this.notes = notes;
    this.#schedule = schedule;
  }

  async close(): Promise<void> {
    await this.#schedule?.stop();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function buildVault(
  option: VaultSetup | Vault | false | undefined,
  notes: string[],
): { vault?: Vault; purge?: () => Promise<unknown> } {
  if (option === false) {
    return {};
  }
  if (option === undefined) {
    // The only place a key is generated: memory dies with the process, so nothing outlives the key.
    const storage = new MemoryVaultStorage();
    const key = generateVaultKey();
    try {
      notes.push('Vault: in memory with a random key; mappings are lost on restart and not shared between processes.');

      return { vault: new EncryptedVault({ storage, key }), purge: () => storage.purgeExpired() };
    } finally {
      key.fill(0);
    }
  }
  // Checked at run time too: callers without type checking, and a VaultStorage passed without a key.
  if (typeof (option as unknown) !== 'object' || (option as unknown) === null) {
    throw new TypeError('The vault must be a VaultSetup ({ storage, key }), a Vault or false.');
  }
  if (!('storage' in option)) {
    if (typeof option.store !== 'function' || typeof option.fetch !== 'function') {
      throw new TypeError(
        'The vault must be a VaultSetup ({ storage, key }), a Vault or false. A VaultStorage alone needs a key: pass { storage, key }.',
      );
    }

    return { vault: option };
  }
  const { storage, key, previousKeys, purge } = option;
  if ((key as Uint8Array | undefined) === undefined) {
    // No silent fallback to a random key: entries in a persistent storage would become unreadable.
    throw new TypeError(
      'The vault needs a key (32 bytes), e.g. vaultKeyFromEnv(). It is never generated for a storage.',
    );
  }
  const vault = new EncryptedVault({ storage, key, previousKeys });
  if (purge === false) {
    return { vault };
  }
  if (purge !== undefined) {
    return { vault, purge };
  }
  const own = (storage as Partial<{ purgeExpired: () => Promise<unknown> }>).purgeExpired;

  return typeof own === 'function' ? { vault, purge: () => own.call(storage) } : { vault };
}
