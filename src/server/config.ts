import { ModelDetector } from '../model/model-detector.js';
import { EntityLearner } from '../learning/entity-learner.js';
import { JsonFileCustomEntityStore } from '../learning/json-file-store.js';
import { type CustomEntityStore, InMemoryCustomEntityStore, KeyValueCustomEntityStore } from '../learning/store.js';
import { localPeerMatcher, splitList } from '../service/local-peer.js';
import { ServiceApi } from '../service/service-api.js';
import { EncryptedVault, generateVaultKey, parseVaultKey, previousVaultKeysFromEnv } from '../vault/encrypted-vault.js';
import { MemoryVaultStorage } from '../vault/memory-vault-storage.js';
import type { VaultStorage } from '../vault/vault.js';
import type { PostgresQuery } from '../postgres/index.js';
import { DEFAULT_MAX_BODY_BYTES } from './http-server.js';
import { MODEL_PROVIDERS, type ModelProvider, providerModel } from './model-providers.js';

/** A configuration problem; the message names the variable, never a secret. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

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

interface RedisLike {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer | string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/** The part of a `pg` Pool the service uses. */
interface PoolLike {
  query: PostgresQuery;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}

/**
 * Builds the service from environment variables (names as in the PHP service where they exist; see
 * docs/server.md). Used by the `pii-shield` CLI.
 *
 * @throws ConfigError
 */
export async function serviceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ServiceFromEnvOptions = {},
): Promise<EnvService> {
  const get = (name: string): string | undefined => {
    const value = env[name];

    return value === undefined || value === '' ? undefined : value;
  };
  const notes: string[] = [];
  let redis: RedisLike | undefined;
  const connectRedis = async (): Promise<RedisLike> => {
    const url = get('PII_SERVICE_REDIS_URL') ?? get('PII_DEMO_REDIS_URL');
    if (url === undefined) {
      throw new ConfigError('Set PII_SERVICE_REDIS_URL to use the redis store.');
    }
    if (redis === undefined) {
      let Redis: new (url: string) => RedisLike;
      try {
        ({ Redis } = (await import('ioredis')) as unknown as { Redis: new (url: string) => RedisLike });
      } catch {
        throw new ConfigError('The redis store needs the package "ioredis" (npm install ioredis).');
      }
      redis = new Redis(url);
    }

    return redis;
  };
  const onError =
    options.onError ??
    ((error: unknown, task: BackgroundTask) => {
      const { name = 'Error', code } = (error ?? {}) as { name?: string; code?: unknown };
      process.stderr.write(`pii-shield: ${task} failed (${name}${typeof code === 'string' ? ` ${code}` : ''})\n`);
    });
  let pool: PoolLike | undefined;
  const databaseUrl = get('PII_SERVICE_DATABASE_URL');
  const connectPostgres = async (): Promise<PostgresQuery> => {
    if (databaseUrl === undefined) {
      throw new ConfigError('Set PII_SERVICE_DATABASE_URL to use the postgres store.');
    }
    if (pool === undefined) {
      if (!/^postgres(?:ql)?:\/\//.test(databaseUrl) || !URL.canParse(databaseUrl)) {
        // Never quote the URL: it usually contains the password.
        throw new ConfigError('PII_SERVICE_DATABASE_URL must be a postgres:// or postgresql:// URL.');
      }
      type PoolConstructor = new (config: { connectionString: string }) => PoolLike;
      let Pool: PoolConstructor | undefined;
      try {
        const pg = (await import('pg')) as unknown as { Pool?: PoolConstructor; default?: { Pool?: PoolConstructor } };
        Pool = pg.Pool ?? pg.default?.Pool;
      } catch {
        // reported below
      }
      if (Pool === undefined) {
        throw new ConfigError('The postgres store needs the package "pg" (npm install pg).');
      }
      pool = new Pool({ connectionString: databaseUrl });
      // An idle connection that fails (database restart) must not crash the process.
      pool.on('error', (error) => {
        onError(error, 'database');
      });
    }
    const connected = pool;

    return (text, params) => connected.query(text, params);
  };
  /** An error message for the operator, without the database URL or its password. */
  const safeMessage = (e: unknown): string => {
    let message = e instanceof Error ? e.message : String(e);
    if (databaseUrl !== undefined) {
      message = message.split(databaseUrl).join('<PII_SERVICE_DATABASE_URL>');
      const password = URL.canParse(databaseUrl) ? decodeURIComponent(new URL(databaseUrl).password) : '';
      if (password !== '') {
        message = message.split(password).join('***');
      }
    }

    return message;
  };
  let purgeTimer: NodeJS.Timeout | undefined;
  let purging: Promise<void> | undefined;
  /** Decoded keys, wiped when this function returns (the vault keeps its own copies). */
  const keyMaterial: Uint8Array[] = [];

  try {
    // Vault
    const keyBase64 = get('PII_SERVICE_VAULT_KEY');
    let key: Uint8Array;
    if (keyBase64 === undefined) {
      key = generateVaultKey();
    } else {
      try {
        key = parseVaultKey(keyBase64);
      } catch {
        throw new ConfigError('PII_SERVICE_VAULT_KEY must be 32 bytes, base64-encoded.');
      }
    }
    keyMaterial.push(key);
    let previousKeys: Uint8Array[] = [];
    if (get('PII_SERVICE_VAULT_PREVIOUS_KEYS') !== undefined) {
      if (keyBase64 === undefined) {
        throw new ConfigError('PII_SERVICE_VAULT_PREVIOUS_KEYS needs PII_SERVICE_VAULT_KEY (the current key).');
      }
      try {
        previousKeys = previousVaultKeysFromEnv('PII_SERVICE_VAULT_PREVIOUS_KEYS', env);
      } catch (e) {
        // The message names the variable and the entry's position, never a key.
        throw new ConfigError(e instanceof Error ? e.message : String(e));
      }
      keyMaterial.push(...previousKeys);
    }
    const vaultStore = get('PII_SERVICE_VAULT_STORE') ?? 'memory';
    let storage: VaultStorage;
    if (vaultStore === 'memory') {
      storage = new MemoryVaultStorage();
      notes.push('Vault: in memory; mappings are lost on restart.');
    } else if (vaultStore === 'redis' || vaultStore === 'postgres') {
      if (keyBase64 === undefined) {
        throw new ConfigError(
          `The ${vaultStore} vault store needs PII_SERVICE_VAULT_KEY, or mappings cannot be read after a restart.`,
        );
      }
      if (vaultStore === 'redis') {
        const { RedisVaultStorage } = await import('../vault-redis/index.js');
        storage = new RedisVaultStorage({ client: await connectRedis() });
      } else {
        const { PostgresVaultStorage } = await import('../postgres/index.js');
        const postgres = new PostgresVaultStorage({ query: await connectPostgres() });
        try {
          await postgres.get('pii-shield-startup-check'); // fail at start: no connection, no table, no rights
        } catch (e) {
          throw new ConfigError(
            `The vault table cannot be read: ${safeMessage(e)}. Create the tables with "pii-shield db-schema".`,
          );
        }
        storage = postgres;
        const interval = integer(
          get('PII_SERVICE_VAULT_PURGE_INTERVAL'),
          'PII_SERVICE_VAULT_PURGE_INTERVAL',
          DEFAULT_PURGE_INTERVAL,
          0,
        );
        if (interval > 86_400) {
          throw new ConfigError('PII_SERVICE_VAULT_PURGE_INTERVAL must be at most 86400 (one day).');
        }
        if (interval === 0) {
          notes.push('Vault: expired rows are not purged (PII_SERVICE_VAULT_PURGE_INTERVAL=0); delete them yourself.');
        } else {
          // Expired rows are personal data past their storage period (Art. 5(1)(e) GDPR): delete them.
          const purge = (): void => {
            purging ??= postgres
              .purgeExpired()
              .then(
                () => undefined,
                (e: unknown) => {
                  onError(e, 'vault-purge');
                },
              )
              .finally(() => {
                purging = undefined;
              });
          };
          purge();
          purgeTimer = setInterval(purge, interval * 1000).unref();
        }
      }
    } else {
      throw new ConfigError('PII_SERVICE_VAULT_STORE must be "memory", "redis" or "postgres".');
    }
    const vaultTtl = integer(get('PII_SERVICE_VAULT_TTL'), 'PII_SERVICE_VAULT_TTL', ServiceApi.DEFAULT_VAULT_TTL);

    // Learned types
    const learnedFile = get('PII_SERVICE_LEARNED_TYPES');
    const learnedStore = get('PII_SERVICE_LEARNED_STORE') ?? (learnedFile === undefined ? 'memory' : 'file');
    let store: CustomEntityStore;
    if (learnedStore === 'file') {
      if (learnedFile === undefined) {
        throw new ConfigError('Set PII_SERVICE_LEARNED_TYPES to the JSON file of learned types.');
      }
      store = new JsonFileCustomEntityStore(learnedFile);
    } else if (learnedStore === 'memory') {
      store = new InMemoryCustomEntityStore();
      notes.push('Learned types: in memory; set PII_SERVICE_LEARNED_TYPES to keep them.');
    } else if (learnedStore === 'redis') {
      store = new KeyValueCustomEntityStore(await connectRedis());
    } else if (learnedStore === 'postgres') {
      const { PostgresCustomEntityStore } = await import('../postgres/index.js');
      store = new PostgresCustomEntityStore({ query: await connectPostgres() });
    } else {
      throw new ConfigError('PII_SERVICE_LEARNED_STORE must be "file", "memory", "redis" or "postgres".');
    }
    const keepExamples = get('PII_SERVICE_LEARNED_KEEP_EXAMPLES') ?? 'true';
    if (keepExamples !== 'true' && keepExamples !== 'false') {
      throw new ConfigError('PII_SERVICE_LEARNED_KEEP_EXAMPLES must be "true" or "false".');
    }
    let learner: EntityLearner;
    try {
      learner = await EntityLearner.create({ store, keepExamples: keepExamples === 'true' });
    } catch (e) {
      throw new ConfigError(`The learned types cannot be read: ${safeMessage(e)}`);
    }
    if (!learner.keepExamples && learner.snapshot.some((t) => t.pattern !== null && t.examples.length > 0)) {
      notes.push('Learned types: types learned before still hold examples; EntityLearner.dropExamples() removes them.');
    }

    // Model
    let modelDetector: (() => ModelDetector) | undefined;
    const provider = get('PII_SERVICE_MODEL_PROVIDER');
    if (provider !== undefined) {
      if (!(MODEL_PROVIDERS as readonly string[]).includes(provider)) {
        throw new ConfigError(`PII_SERVICE_MODEL_PROVIDER must be one of ${MODEL_PROVIDERS.join(', ')}.`);
      }
      const keys: Record<ModelProvider, string | undefined> = {
        ollama: undefined,
        generic: get('PII_SERVICE_MODEL_KEY') ?? get('PII_DEMO_GENERIC_KEY'),
        mistral: get('MISTRAL_API_KEY'),
        openai: get('OPENAI_API_KEY'),
        anthropic: get('ANTHROPIC_API_KEY'),
      };
      const typed = provider as ModelProvider;
      let resolved;
      try {
        resolved = providerModel({
          provider: typed,
          model: get('PII_SERVICE_MODEL'),
          endpoint: get('PII_SERVICE_MODEL_URL') ?? (typed === 'ollama' ? get('PII_DEMO_OLLAMA_URL') : undefined),
          apiKey: keys[typed],
        });
      } catch (e) {
        throw new ConfigError(e instanceof Error ? e.message : String(e));
      }
      const acknowledged = get('PII_SERVICE_ACKNOWLEDGE_EXTERNAL') === 'true';
      if (resolved.location === 'external' && !acknowledged) {
        throw new ConfigError(
          `${provider} is an external provider: detection sends the unredacted text there. Set PII_SERVICE_ACKNOWLEDGE_EXTERNAL=true after checking the data processing agreement and third-country transfers.`,
        );
      }
      const options = {
        model: resolved.model,
        location: resolved.location,
        acknowledgeExternalTransfer: acknowledged,
        learnedTypes: learner,
        // Self-hosted models answer only when done; allow for large models on modest hardware (PHP: 170 s).
        timeout: integer(get('PII_SERVICE_MODEL_TIMEOUT'), 'PII_SERVICE_MODEL_TIMEOUT', 170) * 1000,
      };
      try {
        new ModelDetector(options); // fail at start, not per request (external without acknowledgement)
      } catch (e) {
        throw new ConfigError(e instanceof Error ? e.message : String(e));
      }
      modelDetector = () => new ModelDetector(options);
    }

    const api = new ServiceApi({
      vault: new EncryptedVault({ storage, key, previousKeys }), // copies the keys
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
      maxBodyBytes: integer(get('PII_SERVICE_MAX_BODY_BYTES'), 'PII_SERVICE_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
      host: get('PII_SERVICE_HOST') ?? '127.0.0.1',
      port: integer(get('PII_SERVICE_PORT'), 'PII_SERVICE_PORT', 8088, 0),
      notes,
      close: async () => {
        clearInterval(purgeTimer);
        await purging;
        await Promise.all([redis?.quit(), pool?.end()]);
      },
    };
  } catch (e) {
    clearInterval(purgeTimer);
    await purging;
    await Promise.all([redis?.quit().catch(() => undefined), pool?.end().catch(() => undefined)]);
    throw e;
  } finally {
    for (const material of keyMaterial) {
      material.fill(0);
    }
  }
}

/** Seconds between two purges of expired vault rows (Postgres). */
export const DEFAULT_PURGE_INTERVAL = 300;

function integer(value: string | undefined, name: string, fallback: number, min = 1): number {
  if (value === undefined) {
    return fallback;
  }
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer of at least ${String(min)}.`);
  }

  return n;
}
