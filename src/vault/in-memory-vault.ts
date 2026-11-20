/* eslint-disable @typescript-eslint/require-await -- synchronous implementation of an async interface; `async` turns validation errors into rejections */
import type { PlaceholderMapping } from '../redaction.js';
import { assertTtl, type Clock, type Vault } from './vault.js';

export interface InMemoryVaultOptions {
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  clock?: Clock;
}

/**
 * Process-local vault. Suitable for one request or one long-running worker; not shared between processes.
 * Expired mappings are purged on every write, so long-running workers do not accumulate data.
 */
export class InMemoryVault implements Vault {
  readonly #entries = new Map<string, { mapping: PlaceholderMapping; expiresAt: number }>();
  readonly #clock: Clock;

  constructor(options: InMemoryVaultOptions = {}) {
    this.#clock = options.clock ?? Date.now;
  }

  async store(id: string, mapping: PlaceholderMapping, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);

    const now = this.#clock();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
      }
    }
    this.#entries.set(id, {
      mapping: Object.freeze(Object.fromEntries(Object.entries(mapping))),
      expiresAt: now + ttlSeconds * 1000,
    });
  }

  async fetch(id: string): Promise<PlaceholderMapping | null> {
    const entry = this.#entries.get(id);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.#clock()) {
      this.#entries.delete(id);

      return null;
    }

    return entry.mapping;
  }

  async delete(id: string): Promise<void> {
    this.#entries.delete(id);
  }
}
