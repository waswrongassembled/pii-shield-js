/**
 * Reading the service's environment variables (docs/server.md). serviceFromEnv() and the configuration
 * check (`pii-shield doctor`, checkServiceConfig()) share these functions, so they cannot drift apart.
 * Every error is a ConfigError whose message names the variable, never its value.
 */
import { ModelDetector, type DetectionModel, type ModelLocation } from '../model/model-detector.js';
import { parseVaultKey, previousVaultKeysFromEnv } from '../vault/encrypted-vault.js';
import { DEFAULT_PURGE_INTERVAL, MAX_PURGE_INTERVAL } from '../internal/background.js';
import { ServiceApi } from '../service/service-api.js';
import { DEFAULT_MAX_BODY_BYTES } from './http-server.js';
import { MODEL_PROVIDERS, type ModelProvider, providerModel } from './model-providers.js';

/** A configuration problem; the message names the variable, never a secret. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export type Env = Readonly<Record<string, string | undefined>>;
/** A variable's value; unset and empty both give undefined. */
export type EnvGetter = (name: string) => string | undefined;

export function envGetter(env: Env): EnvGetter {
  return (name) => {
    const value = env[name];

    return value === undefined || value === '' ? undefined : value;
  };
}

export function integer(value: string | undefined, name: string, fallback: number, min = 1): number {
  if (value === undefined) {
    return fallback;
  }
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min) {
    throw new ConfigError(`${name} must be an integer of at least ${String(min)}.`);
  }

  return n;
}

export interface VaultKeys {
  /** Undefined when PII_SERVICE_VAULT_KEY is not set (the service then uses a random key, memory only). */
  key: Uint8Array | undefined;
  previousKeys: Uint8Array[];
}

/** PII_SERVICE_VAULT_KEY decoded, or undefined when not set. The caller wipes it after use. */
export function readVaultKey(get: EnvGetter): Uint8Array | undefined {
  const keyBase64 = get('PII_SERVICE_VAULT_KEY');
  if (keyBase64 === undefined) {
    return undefined;
  }
  try {
    return parseVaultKey(keyBase64);
  } catch {
    throw new ConfigError('PII_SERVICE_VAULT_KEY must be 32 bytes, base64-encoded.');
  }
}

/** PII_SERVICE_VAULT_PREVIOUS_KEYS decoded (`[]` when not set). The caller wipes them after use. */
export function readPreviousVaultKeys(get: EnvGetter, env: Env): Uint8Array[] {
  if (get('PII_SERVICE_VAULT_PREVIOUS_KEYS') === undefined) {
    return [];
  }
  if (get('PII_SERVICE_VAULT_KEY') === undefined) {
    throw new ConfigError('PII_SERVICE_VAULT_PREVIOUS_KEYS needs PII_SERVICE_VAULT_KEY (the current key).');
  }
  try {
    return previousVaultKeysFromEnv('PII_SERVICE_VAULT_PREVIOUS_KEYS', env);
  } catch (e) {
    // The message names the variable and the entry's position, never a key.
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }
}

/** Both keys, decoded. The caller wipes them after use. */
export function readVaultKeys(get: EnvGetter, env: Env): VaultKeys {
  const key = readVaultKey(get);
  try {
    return { key, previousKeys: readPreviousVaultKeys(get, env) };
  } catch (e) {
    key?.fill(0);
    throw e;
  }
}

export type VaultStoreKind = 'memory' | 'redis' | 'postgres';

export function readVaultStore(get: EnvGetter): VaultStoreKind {
  const store = get('PII_SERVICE_VAULT_STORE') ?? 'memory';
  if (store !== 'memory' && store !== 'redis' && store !== 'postgres') {
    throw new ConfigError('PII_SERVICE_VAULT_STORE must be "memory", "redis" or "postgres".');
  }

  return store;
}

/** A persistent vault store needs a fixed key: a random one could not read the entries after a restart. */
export function assertVaultKeyFor(store: VaultStoreKind, hasKey: boolean): void {
  if (store !== 'memory' && !hasKey) {
    throw new ConfigError(
      `The ${store} vault store needs PII_SERVICE_VAULT_KEY, or mappings cannot be read after a restart.`,
    );
  }
}

export function readVaultTtl(get: EnvGetter): number {
  return integer(get('PII_SERVICE_VAULT_TTL'), 'PII_SERVICE_VAULT_TTL', ServiceApi.DEFAULT_VAULT_TTL);
}

/** Seconds between purges of expired Postgres vault rows; 0 = off. */
export function readPurgeInterval(get: EnvGetter): number {
  const interval = integer(
    get('PII_SERVICE_VAULT_PURGE_INTERVAL'),
    'PII_SERVICE_VAULT_PURGE_INTERVAL',
    DEFAULT_PURGE_INTERVAL,
    0,
  );
  if (interval > MAX_PURGE_INTERVAL) {
    throw new ConfigError('PII_SERVICE_VAULT_PURGE_INTERVAL must be at most 86400 (one day).');
  }

  return interval;
}

export type LearnedStoreKind = 'file' | 'memory' | 'redis' | 'postgres';

export function readLearnedStore(get: EnvGetter): { kind: LearnedStoreKind; file: string | undefined } {
  const file = get('PII_SERVICE_LEARNED_TYPES');
  const kind = get('PII_SERVICE_LEARNED_STORE') ?? (file === undefined ? 'memory' : 'file');
  if (kind !== 'file' && kind !== 'memory' && kind !== 'redis' && kind !== 'postgres') {
    throw new ConfigError('PII_SERVICE_LEARNED_STORE must be "file", "memory", "redis" or "postgres".');
  }
  if (kind === 'file' && file === undefined) {
    throw new ConfigError('Set PII_SERVICE_LEARNED_TYPES to the JSON file of learned types.');
  }

  return { kind, file };
}

export function readKeepExamples(get: EnvGetter): boolean {
  const keepExamples = get('PII_SERVICE_LEARNED_KEEP_EXAMPLES') ?? 'true';
  if (keepExamples !== 'true' && keepExamples !== 'false') {
    throw new ConfigError('PII_SERVICE_LEARNED_KEEP_EXAMPLES must be "true" or "false".');
  }

  return keepExamples === 'true';
}

export function readRedisUrl(get: EnvGetter): string {
  const url = get('PII_SERVICE_REDIS_URL') ?? get('PII_DEMO_REDIS_URL');
  if (url === undefined) {
    throw new ConfigError('Set PII_SERVICE_REDIS_URL to use the redis store.');
  }

  return url;
}

/** PII_SERVICE_DATABASE_URL, checked to be a postgres URL (the message never quotes it: it holds the password). */
export function readDatabaseUrl(get: EnvGetter): string {
  const url = get('PII_SERVICE_DATABASE_URL');
  if (url === undefined) {
    throw new ConfigError('Set PII_SERVICE_DATABASE_URL to use the postgres store.');
  }
  if (!/^postgres(?:ql)?:\/\//.test(url) || !URL.canParse(url)) {
    throw new ConfigError('PII_SERVICE_DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }

  return url;
}

export interface ModelConfig {
  provider: ModelProvider;
  model: DetectionModel;
  location: ModelLocation;
  acknowledged: boolean;
  /** Milliseconds per detection. */
  timeout: number;
}

/**
 * The model provider (PII_SERVICE_MODEL_PROVIDER and its settings), or undefined without one. Refuses an
 * external provider without PII_SERVICE_ACKNOWLEDGE_EXTERNAL=true.
 */
export function readModel(get: EnvGetter): ModelConfig | undefined {
  const provider = get('PII_SERVICE_MODEL_PROVIDER');
  if (provider === undefined) {
    return undefined;
  }
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
  const config: ModelConfig = {
    provider: typed,
    model: resolved.model,
    location: resolved.location,
    acknowledged,
    // Self-hosted models answer only when done; allow for large models on modest hardware (PHP: 170 s).
    timeout: integer(get('PII_SERVICE_MODEL_TIMEOUT'), 'PII_SERVICE_MODEL_TIMEOUT', 170) * 1000,
  };
  try {
    // Fail at start, not per request.
    new ModelDetector({
      model: config.model,
      location: config.location,
      acknowledgeExternalTransfer: acknowledged,
      timeout: config.timeout,
    });
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : String(e));
  }

  return config;
}

/** Listen address and request limits. */
export function readListen(get: EnvGetter): { host: string; port: number; maxBodyBytes: number } {
  return {
    maxBodyBytes: integer(get('PII_SERVICE_MAX_BODY_BYTES'), 'PII_SERVICE_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    host: get('PII_SERVICE_HOST') ?? '127.0.0.1',
    port: integer(get('PII_SERVICE_PORT'), 'PII_SERVICE_PORT', 8088, 0),
  };
}
