import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { VaultError } from '../errors.js';
import { encodePhpJson } from '../internal/php-json.js';
import type { PlaceholderMapping } from '../redaction.js';
import { assertTtl, type Vault, type VaultStorage } from './vault.js';

const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export interface EncryptedVaultOptions {
  /** Where the ciphertext goes; it never sees clear text. */
  storage: VaultStorage;
  /** 32 raw bytes, see generateVaultKey() and parseVaultKey(). The vault keeps its own copy. */
  key: Uint8Array;
}

/**
 * Encrypts mappings with XChaCha20-Poly1305 before they reach the storage. Byte-compatible with PHP's
 * EncryptedVault: payload `nonce(24) || ciphertext+tag`, the vault id (UTF-8) as associated data, and
 * the plaintext encoded like PHP's `json_encode()`. PHP and Node read each other's entries.
 *
 * The vault id is bound as associated data, so a ciphertext copied to another id fails to decrypt.
 * This is the only supported way to persist mappings.
 */
export class EncryptedVault implements Vault {
  readonly #storage: VaultStorage;
  readonly #key: Uint8Array;

  constructor(options: EncryptedVaultOptions) {
    const { storage, key } = options;
    if (!(key instanceof Uint8Array)) {
      throw new TypeError('The key must be a Uint8Array of 32 raw bytes, see parseVaultKey().');
    }
    if (key.length !== KEY_BYTES) {
      throw new RangeError(`The key must be ${String(KEY_BYTES)} bytes long.`);
    }
    this.#storage = storage;
    this.#key = key.slice();
  }

  async store(id: string, mapping: PlaceholderMapping, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);

    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    await this.#storage.put(id, encryptMapping(this.#key, id, mapping, nonce), ttlSeconds);
  }

  async fetch(id: string): Promise<PlaceholderMapping | null> {
    const payload = await this.#storage.get(id);
    if (payload === null) {
      return null;
    }

    let plaintext: Uint8Array;
    try {
      if (payload.length <= NONCE_BYTES) {
        throw new RangeError('payload too short');
      }
      plaintext = xchacha20poly1305(this.#key, payload.subarray(0, NONCE_BYTES), utf8(id)).decrypt(
        payload.subarray(NONCE_BYTES),
      );
    } catch {
      throw new VaultError('Vault entry cannot be decrypted (wrong key or tampered data).', 'VAULT_DECRYPTION_FAILED');
    }

    try {
      return decodeMapping(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  async delete(id: string): Promise<void> {
    await this.#storage.remove(id);
  }
}

/** A new random key (32 raw bytes). Store it base64-encoded as a secret; read it back with parseVaultKey(). */
export function generateVaultKey(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

/** Canonical base64 (with padding), as PHP's base64_encode() writes it. Linear: fixed-size groups. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes a base64 key (e.g. from an environment variable or a secret file; surrounding whitespace is
 * ignored). Throws without echoing the input.
 */
export function parseVaultKey(base64: string): Uint8Array {
  const trimmed = base64.trim();
  if (!BASE64.test(trimmed)) {
    throw new TypeError('The key must be base64-encoded.');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  const key = new Uint8Array(decoded);
  decoded.fill(0);
  if (key.length !== KEY_BYTES) {
    key.fill(0);
    throw new RangeError(`The key must be ${String(KEY_BYTES)} bytes long.`);
  }

  return key;
}

/**
 * Encrypts a mapping with a given nonce: the seam for byte-parity tests with PHP payloads. Not public API:
 * reusing a nonce breaks XChaCha20-Poly1305.
 *
 * @internal
 */
export function encryptMapping(
  key: Uint8Array,
  id: string,
  mapping: PlaceholderMapping,
  nonce: Uint8Array,
): Uint8Array {
  const plaintext = utf8(encodePhpJson(mapping));
  try {
    const ciphertext = xchacha20poly1305(key, nonce, utf8(id)).encrypt(plaintext);
    const payload = new Uint8Array(NONCE_BYTES + ciphertext.length);
    payload.set(nonce);
    payload.set(ciphertext, NONCE_BYTES);

    return payload;
  } finally {
    plaintext.fill(0);
  }
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// fatal: invalid UTF-8 fails like PHP's json_decode(); ignoreBOM: keep a BOM so JSON.parse() rejects it like PHP.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Integer-like keys become ints in a PHP array, which PHP's EncryptedVault rejects as corrupt. */
const PHP_INT_KEY = /^(?:0|-?[1-9][0-9]{0,18})$/;
const PHP_INT_MIN = -(2n ** 63n);
const PHP_INT_MAX = 2n ** 63n - 1n;

/**
 * PHP's `json_decode()` plus its string-map check. Errors carry no cause: JSON.parse() messages quote the
 * plaintext, which holds personal data.
 */
function decodeMapping(plaintext: Uint8Array): PlaceholderMapping {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw corrupt();
  }

  if (Array.isArray(parsed)) {
    // PHP encodes an empty mapping as [], a non-empty list has integer keys.
    if (parsed.length === 0) {
      return Object.freeze({});
    }
    throw corrupt();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw corrupt();
  }

  const entries = Object.entries(parsed);
  for (const [placeholder, original] of entries) {
    if (typeof original !== 'string' || isPhpIntKey(placeholder)) {
      throw corrupt();
    }
  }

  // fromEntries defines own properties, so a "__proto__" key stays a key.
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function isPhpIntKey(key: string): boolean {
  if (!PHP_INT_KEY.test(key)) {
    return false;
  }
  const value = BigInt(key);

  return value >= PHP_INT_MIN && value <= PHP_INT_MAX;
}

function corrupt(): VaultError {
  return new VaultError('Vault entry is corrupt.', 'VAULT_CORRUPT');
}
