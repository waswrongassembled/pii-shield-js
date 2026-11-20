import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it } from 'vitest';

import {
  EncryptedVault,
  generateVaultKey,
  InMemoryVault,
  MemoryVaultStorage,
  parseVaultKey,
  PiiShieldError,
  VaultError,
  type VaultStorage,
} from '../src/index.js';
import { encodePhpJson } from '../src/internal/php-json.js';
import { encryptMapping } from '../src/vault/encrypted-vault.js';
import { loadFixture } from './support/fixtures.js';

const MAPPING = { '⟦PERSON_1⟧': 'Maria Musterfrau', '⟦SVNR_1⟧': '4568 150392' };
const KEY = new Uint8Array(32).fill(1);

function fakeClock(start = 1_700_000_000_000): { now: () => number; sleep: (seconds: number) => void } {
  let now = start;

  return {
    now: () => now,
    sleep: (seconds) => {
      now += seconds * 1000;
    },
  };
}

// Ported from tests/Vault/InMemoryVaultTest.php.
describe('InMemoryVault', () => {
  it('fetches a stored mapping', async () => {
    const vault = new InMemoryVault();
    await vault.store('id-1', MAPPING, 60);

    expect(await vault.fetch('id-1')).toEqual(MAPPING);
  });

  it('returns null for an unknown id', async () => {
    expect(await new InMemoryVault().fetch('unknown')).toBeNull();
  });

  it('deletes a mapping', async () => {
    const vault = new InMemoryVault();
    await vault.store('id-1', MAPPING, 60);

    await vault.delete('id-1');

    expect(await vault.fetch('id-1')).toBeNull();
  });

  it('expires a mapping after its TTL', async () => {
    const clock = fakeClock();
    const vault = new InMemoryVault({ clock: clock.now });
    await vault.store('id-1', MAPPING, 60);

    clock.sleep(59);
    expect(await vault.fetch('id-1')).toEqual(MAPPING);

    clock.sleep(1);
    expect(await vault.fetch('id-1')).toBeNull();
  });

  it('keeps a copy, so later changes to the caller object do not leak in', async () => {
    const vault = new InMemoryVault();
    const mapping: Record<string, string> = { ...MAPPING };
    await vault.store('id-1', mapping, 60);

    mapping['⟦PERSON_1⟧'] = 'changed';

    expect(await vault.fetch('id-1')).toEqual(MAPPING);
  });
});

// Ported from tests/Vault/Psr6CacheStorageTest.php (the in-memory storage takes the place of the PSR-6 pool).
describe('MemoryVaultStorage', () => {
  it('puts, gets and removes binary payloads', async () => {
    const storage = new MemoryVaultStorage();
    const payload = Uint8Array.of(0, 98, 105, 110, 0xff);

    await storage.put('id-1', payload, 60);
    expect(await storage.get('id-1')).toEqual(payload);

    await storage.remove('id-1');
    expect(await storage.get('id-1')).toBeNull();
  });

  it('expires after the TTL', async () => {
    const clock = fakeClock();
    const storage = new MemoryVaultStorage({ clock: clock.now });
    await storage.put('id-1', Uint8Array.of(1), 60);

    clock.sleep(61);

    expect(await storage.get('id-1')).toBeNull();
  });

  it('treats ids with reserved characters as plain strings', async () => {
    const storage = new MemoryVaultStorage();
    await storage.put('a/b:c@d', Uint8Array.of(1), 60);

    expect(await storage.get('a/b:c@d')).toEqual(Uint8Array.of(1));
    expect(await storage.get('a_b_c_d')).toBeNull();
  });

  it('copies payloads in and out', async () => {
    const storage = new MemoryVaultStorage();
    const payload = Uint8Array.of(1, 2, 3);
    await storage.put('id-1', payload, 60);

    payload.fill(0);
    (await storage.get('id-1'))?.fill(9);

    expect(await storage.get('id-1')).toEqual(Uint8Array.of(1, 2, 3));
  });

  it.each([0, -1])('rejects TTL %s', async (ttl) => {
    await expect(new MemoryVaultStorage().put('id-1', Uint8Array.of(1), ttl)).rejects.toThrow(
      new RangeError('The TTL must be positive.'),
    );
  });
});

describe.each([
  ['InMemoryVault', () => new InMemoryVault()],
  ['EncryptedVault', () => new EncryptedVault({ storage: new MemoryVaultStorage(), key: KEY })],
])('%s TTL validation', (_, create) => {
  it.each([0, -1, -3600])('rejects TTL %s with the PHP message', async (ttl) => {
    await expect(create().store('id-1', MAPPING, ttl)).rejects.toThrow(new RangeError('The TTL must be positive.'));
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects non-integer TTL %s', async (ttl) => {
    await expect(create().store('id-1', MAPPING, ttl)).rejects.toThrow(TypeError);
  });
});

// Ported from tests/Vault/EncryptedVaultTest.php.
describe('EncryptedVault', () => {
  function setup(): { storage: MemoryVaultStorage; clock: ReturnType<typeof fakeClock> } {
    const clock = fakeClock();

    return { storage: new MemoryVaultStorage({ clock: clock.now }), clock };
  }

  it('round-trips a mapping', async () => {
    const vault = new EncryptedVault({ storage: setup().storage, key: KEY });
    await vault.store('id-1', MAPPING, 60);

    expect(await vault.fetch('id-1')).toEqual(MAPPING);
  });

  it('never hands clear text to the storage', async () => {
    const puts: Uint8Array[] = [];
    const storage: VaultStorage = {
      put: (_id, payload) => {
        puts.push(payload);

        return Promise.resolve();
      },
      get: () => Promise.resolve(null),
      remove: () => Promise.resolve(),
    };
    await new EncryptedVault({ storage, key: KEY }).store('id-1', MAPPING, 60);

    const stored = Buffer.concat(puts).toString('latin1');
    expect(stored).not.toBe('');
    for (const [placeholder, original] of Object.entries(MAPPING)) {
      expect(stored).not.toContain(original);
      expect(stored).not.toContain('PERSON');
      expect(Buffer.concat(puts).includes(Buffer.from(placeholder))).toBe(false);
    }
  });

  it('returns null for an unknown id', async () => {
    expect(await new EncryptedVault({ storage: setup().storage, key: KEY }).fetch('unknown')).toBeNull();
  });

  it('deletes a mapping', async () => {
    const vault = new EncryptedVault({ storage: setup().storage, key: KEY });
    await vault.store('id-1', MAPPING, 60);

    await vault.delete('id-1');

    expect(await vault.fetch('id-1')).toBeNull();
  });

  it('expires a mapping after its TTL', async () => {
    const { storage, clock } = setup();
    const vault = new EncryptedVault({ storage, key: KEY });
    await vault.store('id-1', MAPPING, 60);

    clock.sleep(61);

    expect(await vault.fetch('id-1')).toBeNull();
  });

  it('cannot decrypt with a wrong key', async () => {
    const { storage } = setup();
    await new EncryptedVault({ storage, key: KEY }).store('id-1', MAPPING, 60);

    const fetch = new EncryptedVault({ storage, key: generateVaultKey() }).fetch('id-1');

    await expect(fetch).rejects.toThrow(VaultError);
  });

  it('binds the ciphertext to its id', async () => {
    const { storage } = setup();
    const vault = new EncryptedVault({ storage, key: KEY });
    await vault.store('id-1', MAPPING, 60);

    // An attacker with storage access copies the ciphertext to another id.
    const ciphertext = await storage.get('id-1');
    expect(ciphertext).not.toBeNull();
    await storage.put('id-2', ciphertext ?? new Uint8Array(), 60);

    await expect(vault.fetch('id-2')).rejects.toThrow('Vault entry cannot be decrypted (wrong key or tampered data).');
  });

  it.each([
    ['too short', new Uint8Array(31)],
    ['too long', new Uint8Array(33)],
    ['empty', new Uint8Array(0)],
  ])('rejects a key that is %s', (_, key) => {
    expect(() => new EncryptedVault({ storage: setup().storage, key })).toThrow(
      new RangeError('The key must be 32 bytes long.'),
    );
  });

  it('rejects a key that is not bytes', () => {
    const key = 'obi5jfaIIYizG5L9SsLwZcKiTq8T66coeawtjD63KD8=' as unknown as Uint8Array;

    expect(() => new EncryptedVault({ storage: setup().storage, key })).toThrow(TypeError);
  });

  it('copies the key, so wiping the caller buffer does not break the vault', async () => {
    const key = KEY.slice();
    const vault = new EncryptedVault({ storage: setup().storage, key });
    key.fill(0);

    await vault.store('id-1', MAPPING, 60);

    expect(await vault.fetch('id-1')).toEqual(MAPPING);
  });

  it('never shows the key in error messages or inspection output', async () => {
    const { storage } = setup();
    await new EncryptedVault({ storage, key: KEY }).store('id-1', MAPPING, 60);
    const vault = new EncryptedVault({ storage, key: generateVaultKey() });

    const error = await vault.fetch('id-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultError);
    expect(JSON.stringify(error)).not.toContain('Maria');
    expect(String((error as Error).stack)).not.toContain('Maria');
    expect(JSON.stringify(vault)).toBe('{}');
  });

  it('generates random keys', () => {
    expect(generateVaultKey()).toHaveLength(32);
    expect(generateVaultKey()).not.toEqual(generateVaultKey());
  });

  it('round-trips an empty mapping', async () => {
    const vault = new EncryptedVault({ storage: setup().storage, key: KEY });
    await vault.store('id-1', {}, 60);

    expect(await vault.fetch('id-1')).toEqual({});
  });

  it('round-trips lone surrogates (PHP cannot read these, see docs/DEVIATIONS.md)', async () => {
    const vault = new EncryptedVault({ storage: setup().storage, key: KEY });
    const mapping = { '⟦OTHER_1⟧': 'a\u{D800}b\u{DFFF}' };
    await vault.store('id-1', mapping, 60);

    expect(await vault.fetch('id-1')).toEqual(mapping);
  });

  it('reads "__proto__" as an own key, not as the prototype', async () => {
    const { storage } = setup();
    await storage.put('id-1', encryptWith(KEY, 'id-1', '{"__proto__":"x"}'), 60);

    const mapping = await new EncryptedVault({ storage, key: KEY }).fetch('id-1');

    expect(Object.getPrototypeOf(mapping)).toBe(Object.prototype);
    expect(Object.keys(mapping ?? {})).toEqual(['__proto__']);
  });

  it.each([
    ['an object', '{}'],
    ['an empty string key', '{"":"x"}'],
    ['a JSON escape', '{"\\u27e6A_1\\u27e7":"\\/"}'],
  ])('accepts %s', async (_, plaintext) => {
    const { storage } = setup();
    await storage.put('id-1', encryptWith(KEY, 'id-1', plaintext), 60);

    await expect(new EncryptedVault({ storage, key: KEY }).fetch('id-1')).resolves.toEqual(JSON.parse(plaintext));
  });

  // PHP's json_decode() and is_string() checks reject these too.
  it.each([
    ['a byte order mark', '\u{FEFF}{}'],
    ['invalid UTF-8', Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x3a, 0x22, 0x22, 0x7d)],
    ['an integer-like key (PHP turns it into an int)', '{"1":"a"}'],
    ['a negative integer-like key', '{"-7":"a"}'],
    ['the smallest PHP int as key', '{"-9223372036854775808":"a"}'],
    ['the largest PHP int as key', '{"9223372036854775807":"a"}'],
    ['null', 'null'],
    ['a non-empty list', '["a"]'],
    ['a boolean value', '{"a":true}'],
  ])('rejects %s as corrupt', async (_, plaintext) => {
    const { storage } = setup();
    await storage.put('id-1', encryptWith(KEY, 'id-1', plaintext), 60);

    const fetch = new EncryptedVault({ storage, key: KEY }).fetch('id-1');

    await expect(fetch).rejects.toThrow(new VaultError('Vault entry is corrupt.', 'VAULT_CORRUPT'));
  });

  // PHP chains the JsonException as previous (docs/UPSTREAM.md #20); V8's JSON.parse() message quotes the input.
  it('does not leak the decrypted mapping through a JSON error', async () => {
    const { storage } = setup();
    await storage.put('id-1', encryptWith(KEY, 'id-1', '{"⟦PERSON_1⟧":"Maria Musterfrau",'), 60);

    const error: unknown = await new EncryptedVault({ storage, key: KEY }).fetch('id-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).cause).toBeUndefined();
    expect((error as VaultError).message).toBe('Vault entry is corrupt.');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('Musterfrau');
  });

  it('accepts integer-like keys outside the PHP int range (PHP keeps them as strings)', async () => {
    const { storage } = setup();
    await storage.put('id-1', encryptWith(KEY, 'id-1', '{"01":"a","-0":"c","9223372036854775808":"b"}'), 60);

    expect(await new EncryptedVault({ storage, key: KEY }).fetch('id-1')).toEqual({
      '01': 'a',
      '-0': 'c',
      '9223372036854775808': 'b',
    });
  });
});

describe('VaultError', () => {
  it('is a PiiShieldError with a stable code', () => {
    const error = new VaultError('Unknown or expired vault id.', 'VAULT_UNKNOWN_ID');

    expect(error).toBeInstanceOf(PiiShieldError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VaultError');
    expect(error.code).toBe('VAULT_UNKNOWN_ID');
  });
});

describe('parseVaultKey', () => {
  it('decodes a base64 key', () => {
    const key = parseVaultKey(loadFixture('vault').key);

    expect(key).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(key).toString('base64')).toBe(loadFixture('vault').key);
  });

  it('round-trips a generated key', () => {
    const key = generateVaultKey();

    expect(parseVaultKey(Buffer.from(key).toString('base64'))).toEqual(key);
  });

  it('ignores surrounding whitespace (e.g. a trailing newline from a secret file)', () => {
    expect(parseVaultKey(` ${loadFixture('vault').key}\n`)).toHaveLength(32);
  });

  it.each([
    ['too short', Buffer.alloc(31).toString('base64')],
    ['too long', Buffer.alloc(33).toString('base64')],
    ['empty', ''],
  ])('rejects a key that is %s', (_, base64) => {
    expect(() => parseVaultKey(base64)).toThrow(new RangeError('The key must be 32 bytes long.'));
  });

  it.each([
    ['not base64', 'not a key!'],
    ['base64url', Buffer.alloc(32, 0xff).toString('base64url')],
    ['inner whitespace', `${'A'.repeat(20)} ${'A'.repeat(23)}=`],
  ])('rejects %s', (_, base64) => {
    expect(() => parseVaultKey(base64)).toThrow(new TypeError('The key must be base64-encoded.'));
  });

  it('checks long adversarial input in bounded time', () => {
    const start = performance.now();

    for (const input of [`${'A'.repeat(200_000)}!`, 'AAA='.repeat(50_000), `${'A'.repeat(200_001)}==`]) {
      expect(() => parseVaultKey(input)).toThrow();
    }

    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('PHP vault compatibility (fixtures/vault.json)', () => {
  const fixture = loadFixture('vault');
  const key = parseVaultKey(fixture.key);

  it.each(fixture.payloads)('decrypts the PHP payload: $case', async ({ id, mapping, payload }) => {
    const storage = new MemoryVaultStorage();
    await storage.put(id, Buffer.from(payload, 'base64'), 60);

    const fetched = await new EncryptedVault({ storage, key }).fetch(id);

    expect(fetched).toEqual(mapping);
    expect(Object.keys(fetched ?? {})).toEqual(Object.keys(mapping));
  });

  it.each(fixture.payloads)('encodes the mapping like json_encode(): $case', ({ mapping, plaintext }) => {
    expect(encodePhpJson(mapping)).toBe(plaintext);
  });

  it.each(fixture.payloads)('encrypts byte-identically with the same nonce: $case', ({ id, mapping, payload }) => {
    const expected = Buffer.from(payload, 'base64');

    const actual = encryptMapping(key, id, mapping, expected.subarray(0, 24));

    expect(Buffer.from(actual).toString('base64')).toBe(payload);
  });

  it.each(fixture.failures)('fails like PHP: $case', async (failure) => {
    const storage = new MemoryVaultStorage();
    await storage.put(failure.id, Buffer.from(failure.payload, 'base64'), 60);
    const vault = new EncryptedVault({ storage, key: failure.key === undefined ? key : parseVaultKey(failure.key) });

    const error = await vault.fetch(failure.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultError);
    expect((error as Error).message).toBe(failure.error?.message);
  });

  it('rejects a short key with the PHP message', () => {
    expect(() => new EncryptedVault({ storage: new MemoryVaultStorage(), key: new Uint8Array(5) })).toThrow(
      fixture.keyLength.error?.message,
    );
  });

  it('rejects a zero TTL with the PHP message', async () => {
    const vault = new EncryptedVault({ storage: new MemoryVaultStorage(), key });

    await expect(vault.store('x', {}, 0)).rejects.toThrow(fixture.ttl.error?.message);
  });
});

/** A JSON \\u escape, built at runtime so no tool rewrites it in the source. */
const u = (hex: string): string => `\\u${hex}`;

describe('encodePhpJson', () => {
  it.each([
    ['empty mapping as a list', {}, '[]'],
    ['slashes', { a: '/' }, String.raw`{"a":"\/"}`],
    [
      'control characters',
      { a: '\u{0}\u{1}\u{8}\u{9}\u{A}\u{C}\u{D}\u{1F}' },
      String.raw`{"a":"\u0000\u0001\b\t\n\f\r\u001f"}`,
    ],
    ['DEL stays raw', { a: '\u{7F}' }, '{"a":"\u{7F}"}'],
    ['non-ASCII as lowercase escapes', { é: 'Ä€' }, `{"${u('00e9')}":"${u('00c4')}${u('20ac')}"}`],
    ['astral characters as surrogate pairs', { a: '😀' }, `{"a":"${u('d83d')}${u('de00')}"}`],
    ['HTML characters stay raw', { a: `<>&'` }, `{"a":"<>&'"}`],
  ])('%s', (_, mapping, expected) => {
    expect(encodePhpJson(mapping)).toBe(expected);
  });
});

function encryptWith(key: Uint8Array, id: string, plaintext: string | Uint8Array): Uint8Array {
  return encryptRaw(key, id, typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext);
}

function encryptRaw(key: Uint8Array, id: string, plaintext: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(24).fill(7);
  const ciphertext = xchacha20poly1305(key, nonce, new TextEncoder().encode(id)).encrypt(plaintext);

  return Buffer.concat([nonce, ciphertext]);
}
