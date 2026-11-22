import { type PurgeSchedule, reportToStderr, schedulePurge } from '../internal/background.js';
import { EntityLearner } from '../learning/entity-learner.js';
import { JsonFileCustomEntityStore } from '../learning/json-file-store.js';
import { type CustomEntityStore, InMemoryCustomEntityStore, KeyValueCustomEntityStore } from '../learning/store.js';
import { ModelDetector } from '../model/model-detector.js';
import { localPeerMatcher, splitList } from '../service/local-peer.js';
import { ServiceApi } from '../service/service-api.js';
import { EncryptedVault, generateVaultKey } from '../vault/encrypted-vault.js';
import { MemoryVaultStorage } from '../vault/memory-vault-storage.js';
import type { VaultStorage } from '../vault/vault.js';
import { connections } from './connections.js';
import {
  assertVaultKeyFor,
  ConfigError,
  type Env,
  envGetter,
  readKeepExamples,
  readLearnedStore,
  readListen,
  readModel,
  readPurgeInterval,
  readVaultKeys,
  readVaultStore,
  readVaultTtl,
} from './env.js';

export { ConfigError };

export interface EnvService {
  api: ServiceApi;
  allowedHosts: string[];
  maxBodyBytes: number;
  host: string;
  port: number;
  /** Notes for the operator (stderr), e.g. that mappings do not survive a restart. Never secrets. */
  notes: string[];
  /** Stops background tasks (vault purge) and closes connections the configuration opened (Redis, Postgres). */
  close(): Promise<void>;
}

/** Background work of the service; its errors go to `onError`. */
export type BackgroundTask = 'vault-purge' | 'database';

export interface ServiceFromEnvOptions {
  /**
   * Errors of background work: the periodic vault purge and idle database connections. Default:
   * name and code to stderr. The error may carry driver details (a pg error's `detail` can quote row
   * values): log name and code, not the whole error.
   */
  onError?: (error: unknown, task: BackgroundTask) => void;
}

/**
 * Builds the service from environment variables (names as in the PHP service where they exist; see
 * docs/server.md). Used by the `pii-shield` CLI. `pii-shield doctor` (checkServiceConfig()) checks the
 * same variables with the same rules.
 *
 * @throws ConfigError
 */
export async function serviceFromEnv(env: Env = process.env, options: ServiceFromEnvOptions = {}): Promise<EnvService> {
  const get = envGetter(env);
  const notes: string[] = [];
  const onError = options.onError ?? reportToStderr;
  const connection = connections(get, {
    // An idle connection that fails (database restart) must not crash the process.
    onPoolError: (error) => {
      onError(error, 'database');
    },
  });
  let purge: PurgeSchedule | undefined;
  /** Decoded keys, wiped when this function returns (the vault keeps its own copies). */
  const keyMaterial: Uint8Array[] = [];

  try {
    // Vault
    const keys = readVaultKeys(get, env);
    const key = keys.key ?? generateVaultKey();
    keyMaterial.push(key, ...keys.previousKeys);
    const vaultStore = readVaultStore(get);
    assertVaultKeyFor(vaultStore, keys.key !== undefined);
    let storage: VaultStorage;
    if (vaultStore === 'memory') {
      storage = new MemoryVaultStorage();
      notes.push('Vault: in memory; mappings are lost on restart.');
    } else if (vaultStore === 'redis') {
      const { RedisVaultStorage } = await import('../vault-redis/index.js');
      storage = new RedisVaultStorage({ client: await connection.redis() });
    } else {
      const { PostgresVaultStorage } = await import('../postgres/index.js');
      const postgres = new PostgresVaultStorage({ query: await connection.postgres() });
      try {
        await postgres.get('pii-shield-startup-check'); // fail at start: no connection, no table, no rights
      } catch (e) {
        throw new ConfigError(
          `The vault table cannot be read: ${connection.safeMessage(e)}. Create the tables with "pii-shield db-schema".`,
        );
      }
      storage = postgres;
      const interval = readPurgeInterval(get);
      if (interval === 0) {
        notes.push('Vault: expired rows are not purged (PII_SERVICE_VAULT_PURGE_INTERVAL=0); delete them yourself.');
      } else {
        purge = schedulePurge(
          () => postgres.purgeExpired(),
          interval,
          (e) => {
            onError(e, 'vault-purge');
          },
        );
      }
    }
    const vaultTtl = readVaultTtl(get);

    // Learned types
    const learned = readLearnedStore(get);
    let store: CustomEntityStore;
    if (learned.kind === 'file') {
      store = new JsonFileCustomEntityStore(learned.file ?? '');
    } else if (learned.kind === 'memory') {
      store = new InMemoryCustomEntityStore();
      notes.push('Learned types: in memory; set PII_SERVICE_LEARNED_TYPES to keep them.');
    } else if (learned.kind === 'redis') {
      store = new KeyValueCustomEntityStore(await connection.redis());
    } else {
      const { PostgresCustomEntityStore } = await import('../postgres/index.js');
      store = new PostgresCustomEntityStore({ query: await connection.postgres() });
    }
    const keepExamples = readKeepExamples(get);
    let learner: EntityLearner;
    try {
      learner = await EntityLearner.create({ store, keepExamples });
    } catch (e) {
      throw new ConfigError(`The learned types cannot be read: ${connection.safeMessage(e)}`);
    }
    if (!learner.keepExamples && learner.snapshot.some((t) => t.pattern !== null && t.examples.length > 0)) {
      notes.push('Learned types: types learned before still hold examples; EntityLearner.dropExamples() removes them.');
    }

    // Model
    const model = readModel(get);
    const modelDetector =
      model === undefined
        ? undefined
        : () =>
            new ModelDetector({
              model: model.model,
              location: model.location,
              acknowledgeExternalTransfer: model.acknowledged,
              learnedTypes: learner,
              timeout: model.timeout,
            });

    const api = new ServiceApi({
      vault: new EncryptedVault({ storage, key, previousKeys: keys.previousKeys }), // copies the keys
      learner,
      modelDetector,
      token: get('PII_SERVICE_TOKEN'),
      vaultTtl,
      requireToken: get('PII_SERVICE_ONLY') === '1',
      isLocalPeer: localPeerMatcher(splitList(get('PII_LOCAL_PEERS'))),
    });

    return {
      api,
      allowedHosts: splitList(get('PII_SERVICE_ALLOWED_HOSTS')),
      ...readListen(get),
      notes,
      close: async () => {
        await purge?.stop();
        await connection.close();
      },
    };
  } catch (e) {
    await purge?.stop();
    await connection.closeQuietly();
    throw e;
  } finally {
    for (const material of keyMaterial) {
      material.fill(0);
    }
  }
}
