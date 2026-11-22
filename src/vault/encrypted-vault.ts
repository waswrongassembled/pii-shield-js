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
  /**
   * 32 raw bytes, see vaultKeyFromEnv() and parseVaultKey(). Encrypts every new entry and decrypts.
   * The vault keeps its own copy.
   */
  key: Uint8Array;
  /**
   * Keys of earlier rotations (32 raw bytes each, see previousVaultKeysFromEnv()): only for reading
   * entries written before the rotation, tried in order after `key`. Drop a key once the longest TTL
   * since the rotation has passed. The vault keeps its own copies. Node only, PHP has a single key.
   */
  previousKeys?: readonly Uint8Array[] | undefined;
}

/**
 * Encrypts mappings with XChaCha20-Poly1305 before they reach the storage. Byte-compatible with PHP's
 * EncryptedVault: payload `nonce(24) || ciphertext+tag`, the vault id (UTF-8) as associated data, and
 * the plaintext encoded like PHP's `json_encode()`. PHP and Node read each other's entries.
 *
 * The vault id is bound as associated data, so a ciphertext copied to another id fails to decrypt.
 * This is the only supported way to persist mappings.
 *
 * Key rotation (Node only): pass the new `key` and the old one in `previousKeys`. New entries are
 * encrypted with `key`; reading tries `key`, then each previous key. Payloads stay PHP's format, so PHP
 * reads every entry written with the key it has.
 */
export class EncryptedVault implements Vault {
  readonly #storage: VaultStorage;
  readonly #key: Uint8Array;
  /** `key` first, then the previous keys. */
  readonly #decryptionKeys: readonly Uint8Array[];

  constructor(options: EncryptedVaultOptions) {
    const { storage, key } = options;
    const previousKeys: unknown = options.previousKeys ?? [];
    assertKey(key, 'The key');
    if (!Array.isArray(previousKeys)) {
      throw new TypeError('The previous keys must be an array of keys.');
    }
    const previous: Uint8Array[] = [];
    for (const [i, candidate] of (previousKeys as unknown[]).entries()) {
      assertKey(candidate, `Previous key ${String(i + 1)}`);
      previous.push(candidate);
    }
    this.#storage = storage;
    this.#key = key.slice();
    this.#decryptionKeys = Object.freeze([this.#key, ...previous.map((k) => k.slice())]);
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

    const plaintext = decryptWithAny(this.#decryptionKeys, id, payload);
    if (plaintext === null) {
      // Same error whichever key failed, without a cause: nothing about the keys leaves the vault.
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

/** The plaintext, or null if no key authenticates the payload (or it is too short). */
function decryptWithAny(keys: readonly Uint8Array[], id: string, payload: Uint8Array): Uint8Array | null {
  if (payload.length <= NONCE_BYTES) {
    return null;
  }
  const nonce = payload.subarray(0, NONCE_BYTES);
  const ciphertext = payload.subarray(NONCE_BYTES);
  const associatedData = utf8(id);
  for (const key of keys) {
    try {
      return xchacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
    } catch {
      // wrong key or tampered data: try the next key
    }
  }

  return null;
}

function assertKey(key: unknown, what: string): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array)) {
    throw new TypeError(`${what} must be a Uint8Array of 32 raw bytes, see parseVaultKey().`);
  }
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`${what} must be ${String(KEY_BYTES)} bytes long.`);
  }
}

/**
 * A new random key (32 raw bytes), for creating a key once (`npx @waswrongassembled/pii-shield generate-key`
 * prints one base64-encoded). Keep it as a secret and read it with vaultKeyFromEnv() or parseVaultKey(); a
 * key generated at run time cannot read entries after a restart or in another process.
 */
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

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads the vault key (32 bytes, base64) from an environment variable, default `PII_SHIELD_VAULT_KEY`
 * (the service reads `PII_SERVICE_VAULT_KEY`). Create a key once with
 * `npx @waswrongassembled/pii-shield generate-key`.
 *
 * @throws TypeError if the variable is missing, empty or not a 32-byte base64 key; the message names the
 *   variable, never its value
 */
export function vaultKeyFromEnv(name = 'PII_SHIELD_VAULT_KEY', env: Env = process.env): Uint8Array {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new TypeError(
      `${name} is not set. Set it to a vault key (32 bytes, base64), e.g. from "npx @waswrongassembled/pii-shield generate-key".`,
    );
  }
  try {
    return parseVaultKey(value);
  } catch {
    throw new TypeError(`${name} must be a vault key of 32 bytes, base64-encoded.`);
  }
}

/**
 * Reads the keys of earlier rotations (comma-separated, each 32 bytes base64) for
 * `EncryptedVault`'s `previousKeys`, default variable `PII_SHIELD_VAULT_PREVIOUS_KEYS`. Missing or empty
 * gives `[]`.
 *
 * @throws TypeError if an entry is not a 32-byte base64 key; the message names the variable and the
 *   entry's position, never a value
 */
export function previousVaultKeysFromEnv(
  name = 'PII_SHIELD_VAULT_PREVIOUS_KEYS',
  env: Env = process.env,
): Uint8Array[] {
  const entries = (env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const keys: Uint8Array[] = [];
  for (const [i, entry] of entries.entries()) {
    try {
      keys.push(parseVaultKey(entry));
    } catch {
      for (const key of keys) {
        key.fill(0);
      }
      throw new TypeError(
        `${name} must be a comma-separated list of vault keys (32 bytes, base64-encoded); entry ${String(i + 1)} is not.`,
      );
    }
  }

  return keys;
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
