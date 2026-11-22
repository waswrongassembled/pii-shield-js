/* eslint-disable @typescript-eslint/require-await -- synchronous implementation of an async interface; `async` turns validation errors into rejections */
import { assertTtl, type Clock, type VaultStorage } from './vault.js';

export interface MemoryVaultStorageOptions {
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  clock?: Clock;
}

/**
 * Process-local VaultStorage with expiry, for tests and single-process apps that want EncryptedVault's
 * behaviour without a server. Expired entries are purged on every write and by purgeExpired(). Payloads are copied in and out.
 */
export class MemoryVaultStorage implements VaultStorage {
  readonly #entries = new Map<string, { payload: Uint8Array; expiresAt: number }>();
  readonly #clock: Clock;

  constructor(options: MemoryVaultStorageOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);

    await this.purgeExpired();
    this.#entries.set(id, { payload: payload.slice(), expiresAt: this.#clock() + ttlSeconds * 1000 });
  }

  async get(id: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(id);

      return null;
    }

    return entry.payload.slice();
  }

  async remove(id: string): Promise<void> {
    this.#entries.delete(id);
  }

  /**
   * Deletes expired entries (writes do it too). createPiiShield() calls it on its purge timer, so an idle
   * process does not hold expired mappings.
   *
   * @returns the number of deleted entries
   */
  async purgeExpired(): Promise<number> {
    const now = this.#clock();
    let deleted = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        deleted++;
      }
    }

    return deleted;
  }
}
