/**
 * @waswrongassembled/pii-shield/vault-redis: VaultStorage on Redis via ioredis (optional peer dependency).
 */
import { createHash } from 'node:crypto';

import { assertTtl, type VaultStorage } from '../vault/vault.js';

/**
 * The ioredis methods RedisVaultStorage calls. An ioredis `Redis` or `Cluster` instance satisfies it;
 * so does any client with the same signatures.
 */
export interface RedisClient {
  set(key: string, value: Buffer, secondsToken: 'EX', seconds: number): Promise<unknown>;
  getBuffer(key: string): Promise<Buffer | null>;
  del(key: string): Promise<number>;
}

export interface RedisVaultStorageOptions {
  client: RedisClient;
  /** Prepended to every key. Default: `pii_shield_vault.` (the prefix of PHP's Psr6CacheStorage). */
  prefix?: string;
}

/**
 * Stores vault ciphertext in Redis with `SET … EX`, so Redis expires entries itself. Use it behind
 * EncryptedVault, never on its own. Key: `prefix + sha256hex(id)` (ids may come from outside).
 *
 * The client's lifecycle (connect, quit) stays with the caller.
 */
export class RedisVaultStorage implements VaultStorage {
  readonly #client: RedisClient;
  readonly #prefix: string;

  constructor(options: RedisVaultStorageOptions) {
    this.#client = options.client;
    this.#prefix = options.prefix ?? 'pii_shield_vault.';
  }

  async put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);
    await this.#client.set(
      this.#key(id),
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
      'EX',
      ttlSeconds,
    );
  }

  async get(id: string): Promise<Uint8Array | null> {
    const value = await this.#client.getBuffer(this.#key(id));

    return value === null ? null : new Uint8Array(value);
  }

  async remove(id: string): Promise<void> {
    await this.#client.del(this.#key(id));
  }

  #key(id: string): string {
    return this.#prefix + createHash('sha256').update(id, 'utf8').digest('hex');
  }
}
