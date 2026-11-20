import { ModelDetector } from '../model/model-detector.js';
import { EntityLearner } from '../learning/entity-learner.js';
import { JsonFileCustomEntityStore } from '../learning/json-file-store.js';
import { type CustomEntityStore, InMemoryCustomEntityStore, KeyValueCustomEntityStore } from '../learning/store.js';
import { localPeerMatcher, splitList } from '../service/local-peer.js';
import { ServiceApi } from '../service/service-api.js';
import { EncryptedVault, generateVaultKey, parseVaultKey } from '../vault/encrypted-vault.js';
import { MemoryVaultStorage } from '../vault/memory-vault-storage.js';
import type { VaultStorage } from '../vault/vault.js';
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
  /** Closes connections the configuration opened (Redis). */
  close(): Promise<void>;
}

interface RedisLike {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer | string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/**
 * Builds the service from environment variables (names as in the PHP service where they exist; see
 * docs/server.md). Used by the `pii-shield` CLI.
 *
 * @throws ConfigError
 */
export async function serviceFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
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
    const vaultStore = get('PII_SERVICE_VAULT_STORE') ?? 'memory';
    let storage: VaultStorage;
    if (vaultStore === 'memory') {
      storage = new MemoryVaultStorage();
      notes.push('Vault: in memory; mappings are lost on restart.');
    } else if (vaultStore === 'redis') {
      if (keyBase64 === undefined) {
        throw new ConfigError(
          'The redis vault store needs PII_SERVICE_VAULT_KEY, or mappings cannot be read after a restart.',
        );
      }
      const { RedisVaultStorage } = await import('../vault-redis/index.js');
      storage = new RedisVaultStorage({ client: await connectRedis() });
    } else {
      throw new ConfigError('PII_SERVICE_VAULT_STORE must be "memory" or "redis".');
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
    } else {
      throw new ConfigError('PII_SERVICE_LEARNED_STORE must be "file", "memory" or "redis".');
    }
    let learner: EntityLearner;
    try {
      learner = await EntityLearner.create({ store });
    } catch (e) {
      throw new ConfigError(`The learned types cannot be read: ${e instanceof Error ? e.message : String(e)}`);
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
      vault: new EncryptedVault({ storage, key }),
      learner,
      modelDetector,
      token: get('PII_SERVICE_TOKEN'),
      vaultTtl,
      requireToken: get('PII_SERVICE_ONLY') === '1',
      isLocalPeer: localPeerMatcher(splitList(get('PII_LOCAL_PEERS'))),
    });
    key.fill(0);

    return {
      api,
      allowedHosts: splitList(get('PII_SERVICE_ALLOWED_HOSTS')),
      maxBodyBytes: integer(get('PII_SERVICE_MAX_BODY_BYTES'), 'PII_SERVICE_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
      host: get('PII_SERVICE_HOST') ?? '127.0.0.1',
      port: integer(get('PII_SERVICE_PORT'), 'PII_SERVICE_PORT', 8088, 0),
      notes,
      close: async () => {
        await redis?.quit();
      },
    };
  } catch (e) {
    await redis?.quit().catch(() => undefined);
    throw e;
  }
}

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
