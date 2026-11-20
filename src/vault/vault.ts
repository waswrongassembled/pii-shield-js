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
 * Raw byte storage behind EncryptedVault (PHP's VaultStorageInterface). Only ever receives ciphertext.
 * Implement this to plug in any backend (Redis, database, files, ...).
 */
export interface VaultStorage {
  /** @param ttlSeconds positive integer */
  put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void>;
  get(id: string): Promise<Uint8Array | null>;
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
