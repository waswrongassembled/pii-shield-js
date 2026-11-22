import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { piiShieldMiddleware } from '../src/ai-sdk/index.js';
import {
  createPiiShield,
  EntityLearner,
  generateVaultKey,
  InMemoryCustomEntityStore,
  InMemoryVault,
  LearningError,
  type ManagedPiiShield,
  MemoryVaultStorage,
  PiiShield,
  type VaultSetup,
  type VaultStorage,
} from '../src/index.js';
import { PostgresCustomEntityStore, postgresVault } from '../src/postgres/index.js';
import { redisVault } from '../src/vault-redis/index.js';
import { FakeRedis } from './support/fake-redis.js';
import { TEST_DATABASE_URL, testDatabase } from './support/postgres.js';

const LETTER = 'Herrn\nJohann Beispielmann\nSVNR 4568 150392';
const POLICY = {
  name: 'POLICY_NUMBER',
  description: 'Polizzennummer',
  examples: ['POL-2026-004711', 'POL-2025-000815'],
};

/** A storage that records TTLs and purges, with a purge the test resolves by hand. */
class RecordingStorage extends MemoryVaultStorage {
  readonly ttls: number[] = [];
  purges = 0;
  purgeGate: Promise<void> | undefined;

  override async put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void> {
    this.ttls.push(ttlSeconds);
    await super.put(id, payload, ttlSeconds);
  }

  override async purgeExpired(): Promise<number> {
    this.purges++;
    await this.purgeGate;

    return super.purgeExpired();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createPiiShield', () => {
  it('works without options: encrypted vault in memory, learned types in memory, notes for the operator', async () => {
    const shield = await createPiiShield();

    expect(shield).toBeInstanceOf(PiiShield);
    const { redactedText, vaultId } = await shield.redactToVault(LETTER);
    expect(redactedText).toBe('Herrn\n⟦PERSON_1⟧\nSVNR ⟦SVNR_1⟧');
    expect((await shield.restoreFromVault('⟦PERSON_1⟧', vaultId)).text).toBe('Johann Beispielmann');
    expect(shield.notes).toEqual([
      'Vault: in memory with a random key; mappings are lost on restart and not shared between processes.',
      'Learned types: in memory; they are lost on restart.',
    ]);
    await shield[Symbol.asyncDispose]();
  });

  it('includes learned types in detection and stores them without examples by default', async () => {
    const store = new InMemoryCustomEntityStore();
    const shield = await createPiiShield({ learnedTypes: store });
    await shield.learner.learn(POLICY);

    expect(shield.redact('Polizze POL-2026-123456').redactedText).toBe('Polizze ⟦POLICY_NUMBER_1⟧');
    expect(await store.get('POLICY_NUMBER')).toMatchObject({ examples: [], counterExamples: [] });
    expect(shield.learner.keepExamples).toBe(false);
    // Model-only types need their examples, so they are refused.
    await expect(
      shield.learner.learn({ name: 'PET_NAME', description: 'Haustier', examples: ['Bello', 'Rex'] }),
    ).rejects.toThrow(LearningError);
    expect(shield.notes).toEqual([
      'Vault: in memory with a random key; mappings are lost on restart and not shared between processes.',
    ]);
    await shield.close();
  });

  it('keeps examples when asked, and notes types that still hold examples', async () => {
    const store = new InMemoryCustomEntityStore();
    const keeping = await createPiiShield({ learnedTypes: store, keepExamples: true, vault: false });
    await keeping.learner.learn(POLICY);
    expect((await store.get('POLICY_NUMBER'))?.examples).toHaveLength(2);

    const minimal = await createPiiShield({ learnedTypes: store, vault: false });
    expect(minimal.notes).toEqual([
      'Learned types: types learned before still hold examples; learner.dropExamples() removes them.',
    ]);
  });

  it('takes a ready EntityLearner, but not together with keepExamples', async () => {
    const learner = await EntityLearner.create({ store: new InMemoryCustomEntityStore() });
    const shield = await createPiiShield({ learnedTypes: learner, vault: false });
    expect(shield.learner).toBe(learner);

    await expect(createPiiShield({ learnedTypes: learner, keepExamples: false })).rejects.toThrow(
      new TypeError('keepExamples is a setting of the EntityLearner: pass it there, or pass a store.'),
    );
  });

  it('works without a vault for plain redact and restore', async () => {
    const shield = await createPiiShield({ vault: false });
    const result = shield.redact(LETTER);

    expect(shield.restore(result.redactedText, result).text).toBe(LETTER);
    await expect(shield.redactToVault(LETTER)).rejects.toThrow('No vault configured.');
  });

  it('uses a short TTL of 900 seconds unless configured', async () => {
    const storage = new RecordingStorage();
    const key = generateVaultKey();
    const shield = await createPiiShield({ vault: { storage, key } });
    await shield.redactToVault(LETTER);
    const shorter = await createPiiShield({ vault: { storage, key }, vaultTtl: 60 });
    await shorter.redactToVault(LETTER);

    expect(storage.ttls).toEqual([900, 60]);
    await Promise.all([shield.close(), shorter.close()]);
  });

  it('never generates a key for a storage', async () => {
    const storage = new MemoryVaultStorage();
    const message = 'The vault needs a key (32 bytes), e.g. vaultKeyFromEnv(). It is never generated for a storage.';

    await expect(createPiiShield({ vault: { storage } as unknown as VaultSetup })).rejects.toThrow(
      new TypeError(message),
    );
    await expect(createPiiShield({ vault: storage as unknown as VaultSetup })).rejects.toThrow(
      'A VaultStorage alone needs a key: pass { storage, key }.',
    );
    await expect(createPiiShield({ vault: 'memory' as unknown as VaultSetup })).rejects.toThrow(TypeError);
  });

  it('accepts a ready Vault, with previous keys in a VaultSetup', async () => {
    const vault = new InMemoryVault();
    const shield = await createPiiShield({ vault });
    const { vaultId } = await shield.redactToVault(LETTER);
    expect(await vault.fetch(vaultId)).not.toBeNull();

    const storage = new MemoryVaultStorage();
    const [oldKey, newKey] = [generateVaultKey(), generateVaultKey()];
    const before = await createPiiShield({ vault: { storage, key: oldKey } });
    const { redactedText, vaultId: id } = await before.redactToVault(LETTER);
    const after = await createPiiShield({ vault: { storage, key: newKey, previousKeys: [oldKey] } });
    expect((await after.restoreFromVault(redactedText, id)).text).toBe(LETTER);
    await Promise.all([before.close(), after.close()]);
  });

  it('purges at start and on its interval, unref’d, and close() stops it after a running purge', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const storage = new RecordingStorage();
    const shield = await createPiiShield({ vault: { storage, key: generateVaultKey() }, purgeInterval: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.purges).toBe(1);
    expect((setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout).hasRef()).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(storage.purges).toBe(3);

    let release = (): void => undefined;
    storage.purgeGate = new Promise((resolve) => {
      release = resolve;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.purges).toBe(4);
    // A tick while a purge runs is skipped.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.purges).toBe(4);

    let closed = false;
    const closing = shield.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    release();
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storage.purges).toBe(4);
    await shield.close(); // idempotent
  });

  it('purges with the given function, never with purge: false, and not with purgeInterval 0', async () => {
    const purge = vi.fn(() => Promise.resolve());
    const custom = await createPiiShield({
      vault: { storage: new MemoryVaultStorage(), key: generateVaultKey(), purge },
    });
    await custom.close();
    expect(purge).toHaveBeenCalledOnce();

    const storage = new RecordingStorage();
    const never = await createPiiShield({ vault: { storage, key: generateVaultKey(), purge: false } });
    const off = await createPiiShield({ vault: { storage, key: generateVaultKey() }, purgeInterval: 0 });
    await Promise.all([never.close(), off.close()]);
    expect(storage.purges).toBe(0);
    expect(off.notes).toContain('Vault: expired entries are not purged (purgeInterval 0); delete them yourself.');
  });

  it.each([-1, 1.5, 86_401, Number.NaN])('rejects the purge interval %s', async (purgeInterval) => {
    await expect(createPiiShield({ purgeInterval })).rejects.toThrow(
      new RangeError('The purge interval must be an integer from 0 to 86400 seconds.'),
    );
  });

  it('rejects a bad TTL before touching a store', async () => {
    const storage = new RecordingStorage();
    await expect(createPiiShield({ vault: { storage, key: generateVaultKey() }, vaultTtl: 0 })).rejects.toThrow(
      RangeError,
    );
    expect(storage.purges).toBe(0);
  });

  it('reports purge errors to onError, and by default only name and code to stderr', async () => {
    const failing = Object.assign(new Error('DETAIL: Key (name)=(Johann Beispielmann) already exists'), {
      code: '23505',
    });
    const storage = new RecordingStorage();
    storage.purgeGate = Promise.reject(failing);
    storage.purgeGate.catch(() => undefined);
    const onError = vi.fn();
    const shield = await createPiiShield({ vault: { storage, key: generateVaultKey() }, onError });
    await shield.close();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failing, 'vault-purge');

    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const quiet = await createPiiShield({ vault: { storage, key: generateVaultKey() } });
    await quiet.close();
    expect(write.mock.calls).toEqual([['pii-shield: vault-purge failed (Error 23505)\n']]);
  });

  it('fails at start when the vault storage cannot be read, without starting the timer', async () => {
    const purgeExpired = vi.fn(() => Promise.resolve(0));
    const broken: VaultStorage & { purgeExpired(): Promise<number> } = {
      put: () => Promise.resolve(),
      get: () => Promise.reject(new Error('relation "pii_shield_vault" does not exist')),
      remove: () => Promise.resolve(),
      purgeExpired,
    };

    await expect(createPiiShield({ vault: { storage: broken, key: generateVaultKey() } })).rejects.toThrow(
      'relation "pii_shield_vault" does not exist',
    );
    expect(purgeExpired).not.toHaveBeenCalled();
  });

  it('passes detectors and allowlist on, and works with the AI SDK middleware', async () => {
    const shield = await createPiiShield({ vault: false, allowlist: ['Johann Beispielmann'] });
    expect(shield.redact(LETTER).redactedText).toBe('Herrn\nJohann Beispielmann\nSVNR ⟦SVNR_1⟧');

    expectTypeOf(shield).toExtend<PiiShield>();
    expect(piiShieldMiddleware(shield, { vault: true })).toHaveProperty('transformParams');
  });

  it('builds vaults on Redis and Postgres without importing them into the core', async () => {
    const client = new FakeRedis();
    const key = generateVaultKey();
    const shield = await createPiiShield({ vault: redisVault({ client, key }) });
    const { vaultId } = await shield.redactToVault(LETTER);
    await shield.close();
    expect(client.calls.filter(([command]) => command === 'set')).toEqual([
      ['set', expect.stringMatching(/^pii_shield_vault\.[0-9a-f]{64}$/), 'EX', 900],
    ]);
    expect(vaultId).toMatch(/^[0-9a-f]{32}$/);

    const setup = postgresVault({ query: () => Promise.resolve({ rows: [] }), key, table: 'app.vault' });
    expectTypeOf(setup).toExtend<VaultSetup>();
    expect(setup.previousKeys).toBeUndefined();
    expect(typeof setup.storage.purgeExpired).toBe('function');
  });
});

describe.skipIf(TEST_DATABASE_URL === '')('createPiiShield on Postgres (PII_TEST_DATABASE_URL)', () => {
  it('shares vault and learned types, and purges expired rows', async () => {
    const db = await testDatabase();
    const key = generateVaultKey();
    const options = {
      vault: postgresVault({ query: db.query, key, table: db.vaultTable }),
      learnedTypes: new PostgresCustomEntityStore({ query: db.query, table: db.typesTable }),
      purgeInterval: 1,
    };
    let one: ManagedPiiShield | undefined;
    let two: ManagedPiiShield | undefined;
    try {
      one = await createPiiShield(options);
      two = await createPiiShield(options);
      await one.learner.learn(POLICY);
      await two.learner.refresh();
      const { redactedText, vaultId } = await two.redactToVault('Polizze POL-2026-123456');
      expect(redactedText).toBe('Polizze ⟦POLICY_NUMBER_1⟧');
      expect((await one.restoreFromVault(redactedText, vaultId)).text).toBe('Polizze POL-2026-123456');
      const stored = await db.pool.query<{ data: { examples: string[] } }>(
        `SELECT data FROM ${db.typesTable} WHERE name = 'POLICY_NUMBER'`,
      );
      expect(stored.rows[0]?.data.examples).toEqual([]);

      await db.pool.query(`INSERT INTO ${db.vaultTable} VALUES ($1, '\\x00', now() - interval '1 second')`, [
        randomBytes(16).toString('hex'),
      ]);
      const expired = async () =>
        Number(
          (await db.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${db.vaultTable} WHERE expires_at <= now()`))
            .rows[0]?.n,
        );
      await expect.poll(expired, { timeout: 3000 }).toBe(0);
    } finally {
      await one?.close();
      await two?.close();
      await db.close();
    }
  });

  it('fails at start when the table is missing', async () => {
    const db = await testDatabase();
    try {
      await expect(
        createPiiShield({ vault: postgresVault({ query: db.query, key: generateVaultKey(), table: 'missing_vault' }) }),
      ).rejects.toThrow('relation "missing_vault" does not exist');
    } finally {
      await db.close();
    }
  });
});
