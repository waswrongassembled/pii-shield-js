import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  EncryptedVault,
  generateVaultKey,
  InMemoryVault,
  MemoryVaultStorage,
  NullPiiShield,
  PiiShield,
  type Vault,
  VaultError,
} from '../src/index.js';

const LETTER = 'Frau\nMaria Musterfrau\n\nSVNR 4568 150392';
const NO_VAULT = 'No vault configured. Pass a Vault to PiiShield to restore across requests.';

function fakeClock(): { now: () => number; sleep: (seconds: number) => void } {
  let now = 1_700_000_000_000;

  return {
    now: () => now,
    sleep: (seconds) => {
      now += seconds * 1000;
    },
  };
}

// Ported from tests/PiiShieldVaultTest.php.
describe('PiiShield with a vault', () => {
  it('assigns no vault id in the sync redact()', () => {
    const result = new PiiShield({ vault: new InMemoryVault() }).redact(LETTER);

    expect(result).not.toHaveProperty('vaultId');
  });

  it.each([
    ['redactToVault', (shield: PiiShield) => shield.redactToVault(LETTER)],
    ['restoreFromVault', (shield: PiiShield) => shield.restoreFromVault('⟦PERSON_1⟧', 'some-id')],
    ['forget', (shield: PiiShield) => shield.forget('some-id')],
  ])('%s without a vault is a usage error', async (_, call) => {
    const promise = call(new PiiShield());

    await expect(promise).rejects.toThrow(new Error(NO_VAULT));
    await expect(promise).rejects.not.toThrow(VaultError);
  });

  it('stores the mapping under a random id', async () => {
    const vault = new InMemoryVault();
    const shield = new PiiShield({ vault });

    const first = await shield.redactToVault(LETTER);
    const second = await shield.redactToVault(LETTER);

    expect(first.vaultId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.vaultId).not.toBe(second.vaultId);
    expect(await vault.fetch(first.vaultId)).toEqual(first.mapping);
    expect(first.redactedText).toBe(shield.redact(LETTER).redactedText);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('restores in a later request', async () => {
    const storage = new MemoryVaultStorage();
    const key = generateVaultKey();

    // Request 1: redact
    const { vaultId } = await new PiiShield({ vault: new EncryptedVault({ storage, key }) }).redactToVault(LETTER);

    // Request 2: new shield instance, same storage and key
    const restored = await new PiiShield({ vault: new EncryptedVault({ storage, key }) }).restoreFromVault(
      '⟦PERSON_1⟧ hat die SVNR ⟦SVNR_1⟧.',
      vaultId,
    );

    expect(restored.text).toBe('Maria Musterfrau hat die SVNR 4568 150392.');
    expect(restored.isClean).toBe(true);
  });

  it('stores text without PII too', async () => {
    const shield = new PiiShield({ vault: new InMemoryVault() });

    const result = await shield.redactToVault('Kein Personenbezug.');

    expect(result.vaultId).toMatch(/^[0-9a-f]{32}$/);
    expect((await shield.restoreFromVault('Text', result.vaultId)).text).toBe('Text');
  });

  it('forgets a mapping', async () => {
    const shield = new PiiShield({ vault: new InMemoryVault() });
    const { vaultId } = await shield.redactToVault(LETTER);

    await shield.forget(vaultId);

    await expect(shield.restoreFromVault('⟦PERSON_1⟧', vaultId)).rejects.toThrow(
      new VaultError('Unknown or expired vault id.', 'VAULT_UNKNOWN_ID'),
    );
  });

  it('expires a mapping after the configured TTL', async () => {
    const clock = fakeClock();
    const shield = new PiiShield({ vault: new InMemoryVault({ clock: clock.now }), vaultTtl: 300 });
    const { vaultId } = await shield.redactToVault(LETTER);

    clock.sleep(299);
    await expect(shield.restoreFromVault('⟦PERSON_1⟧', vaultId)).resolves.toMatchObject({ text: 'Maria Musterfrau' });

    clock.sleep(2);
    const error = await shield.restoreFromVault('⟦PERSON_1⟧', vaultId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('VAULT_UNKNOWN_ID');
  });

  it('stores with the default TTL of 3600 seconds', async () => {
    const ttls: number[] = [];
    const vault: Vault = {
      store: (_id, _mapping, ttlSeconds) => {
        ttls.push(ttlSeconds);

        return Promise.resolve();
      },
      fetch: () => Promise.resolve(null),
      delete: () => Promise.resolve(),
    };

    await new PiiShield({ vault }).redactToVault(LETTER);
    await new PiiShield({ vault, vaultTtl: 60 }).redactToVault(LETTER);

    expect(ttls).toEqual([3600, 60]);
    expect(PiiShield.DEFAULT_VAULT_TTL).toBe(3600);
  });

  it.each([0, -1])('rejects vault TTL %s early', (vaultTtl) => {
    expect(() => new PiiShield({ vault: new InMemoryVault(), vaultTtl })).toThrow(
      new RangeError('The vault TTL must be positive.'),
    );
  });

  it.each([1.5, Number.NaN])('rejects non-integer vault TTL %s', (vaultTtl) => {
    expect(() => new PiiShield({ vaultTtl })).toThrow(TypeError);
  });

  it('passes vault errors through', async () => {
    const storage = new MemoryVaultStorage();
    const { vaultId } = await new PiiShield({
      vault: new EncryptedVault({ storage, key: generateVaultKey() }),
    }).redactToVault(LETTER);

    const restore = new PiiShield({
      vault: new EncryptedVault({ storage, key: generateVaultKey() }),
    }).restoreFromVault('⟦PERSON_1⟧', vaultId);

    await expect(restore).rejects.toThrow('Vault entry cannot be decrypted (wrong key or tampered data).');
  });

  it('hides the mapping but shows the vault id in debug output', async () => {
    const result = await new PiiShield({ vault: new InMemoryVault() }).redactToVault(LETTER);

    const dump = inspect(result, { depth: 5 });

    expect(dump).not.toContain('Maria Musterfrau');
    expect(dump).toContain(result.vaultId);
  });
});

describe('NullPiiShield', () => {
  it('has no vault methods, like PHP', () => {
    expect('redactToVault' in new NullPiiShield()).toBe(false);
    expect('restoreFromVault' in new NullPiiShield()).toBe(false);
  });
});
