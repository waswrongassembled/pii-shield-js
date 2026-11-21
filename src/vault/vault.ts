import type { PlaceholderMapping } from '../redaction.js';

/**
 * Stores placeholder → original mappings between requests (PHP's VaultInterface, see docs/adr/0005 there).
 *
 * Implementations that persist data outside the process must encrypt it: use EncryptedVault with a
 * VaultStorage instead of implementing this directly.
 */
export interface Vault {
  /**
   * @param ttlSeconds must be a positive integer; mappings must not live forever
   * @throws RangeError if the TTL is not positive
   */
  store(id: string, mapping: PlaceholderMapping, ttlSeconds: number): Promise<void>;
  /**
   * @returns null if the id is unknown or expired
   * @throws VaultError if stored data cannot be read (tampered, wrong key)
   */
  fetch(id: string): Promise<PlaceholderMapping | null>;
  delete(id: string): Promise<void>;
}

/**
 * Raw byte storage behind EncryptedVault (PHP's VaultStorageInterface). Implement this to plug in any
 * backend (Redis, a database, files, ...), and check it with `verifyVaultStorage()` from
 * `@waswrongassembled/pii-shield/testing`.
 *
 * Behind EncryptedVault it only ever receives ciphertext: never use a storage on its own for mappings.
 *
 * Contract every implementation keeps:
 * - Ids are arbitrary strings that may come from outside (a client's `vaultId`): map them to keys
 *   safely, e.g. by hashing, never by building a path or a query from them.
 * - Payloads are binary-safe (every byte value, any length) and copied: later changes to the array
 *   passed to `put()` or returned by `get()` do not change the stored entry.
 * - `put()` overwrites an existing entry, payload and expiry.
 * - `get()` of an unknown or expired id gives `null`. Expiry is checked on read, not left to a cleanup
 *   job; expired entries must still be deleted eventually (storage limitation, Art. 5(1)(e) GDPR).
 * - `remove()` of an unknown id is a no-op.
 * - A TTL that is not a positive integer rejects the Promise (see assertTtl()) before anything is stored.
 */
export interface VaultStorage {
  /** @param ttlSeconds positive integer */
  put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void>;
  /** @returns a copy of the payload, or null if the id is unknown or expired */
  get(id: string): Promise<Uint8Array | null>;
  /** Deletes the entry; resolves also if there is none. */
  remove(id: string): Promise<void>;
}

/** Current time in milliseconds, like `Date.now` (PHP takes a PSR-20 clock). Inject one in tests. */
export type Clock = () => number;

/**
 * Throws PHP's message for a TTL that is not positive.
 *
 * @internal
 */
export function assertTtl(ttlSeconds: number, message = 'The TTL must be positive.'): void {
  if (typeof ttlSeconds !== 'number' || Number.isNaN(ttlSeconds)) {
    throw new TypeError(`${message.slice(0, -' positive.'.length)} a number of seconds.`);
  }
  if (ttlSeconds <= 0) {
    throw new RangeError(message);
  }
  if (!Number.isSafeInteger(ttlSeconds)) {
    throw new TypeError(`${message.slice(0, -' positive.'.length)} an integer number of seconds.`);
  }
}
