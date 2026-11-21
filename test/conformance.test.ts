import { AssertionError } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type CustomEntityStore,
  type CustomEntityType,
  InMemoryCustomEntityStore,
  JsonFileCustomEntityStore,
  KeyValueCustomEntityStore,
  type KeyValueStore,
  MemoryVaultStorage,
  type VaultStorage,
} from '../src/index.js';
import { PostgresCustomEntityStore, PostgresVaultStorage } from '../src/postgres/index.js';
import { verifyCustomEntityStore, verifyVaultStorage } from '../src/testing/index.js';
import { RedisVaultStorage } from '../src/vault-redis/index.js';
import { FakeRedis } from './support/fake-redis.js';
import { TEST_DATABASE_URL, type TestDatabase, testDatabase } from './support/postgres.js';

/** A Map behind KeyValueStore, as a Redis or database key would be. */
function mapKeyValue(map = new Map<string, string>()): KeyValueStore {
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);

      return Promise.resolve();
    },
  };
}

describe('verifyVaultStorage() on the built-in storages', () => {
  it('MemoryVaultStorage with an injected clock', async () => {
    let now = 0;
    const report = await verifyVaultStorage(() => new MemoryVaultStorage({ clock: () => now }), {
      expire: () => {
        now += 61_000;
      },
    });

    expect(report.skipped).toEqual([expect.stringContaining('secondInstance')]);
  });

  it('RedisVaultStorage over a fake Redis', async () => {
    const clients = new WeakMap<VaultStorage, FakeRedis>();
    const report = await verifyVaultStorage(
      () => {
        const client = new FakeRedis();
        const storage = new RedisVaultStorage({ client });
        clients.set(storage, client);

        return storage;
      },
      {
        expire: (storage) => {
          const client = clients.get(storage);
          if (client !== undefined) {
            client.now += 61_000;
          }
        },
        secondInstance: (storage) => {
          const client = clients.get(storage);
          if (client === undefined) {
            throw new Error('unknown storage');
          }

          return new RedisVaultStorage({ client });
        },
      },
    );

    expect(report.skipped).toEqual([]);
  });

  it('reports the expiry rules as skipped without expire or realTimeExpiry', async () => {
    const report = await verifyVaultStorage(() => new MemoryVaultStorage());

    expect(report.skipped).toEqual([
      'get() of an expired entry gives null (needs the option "expire")',
      'put() over an expired entry stores it again (needs the option "expire")',
      'entries are shared between instances over the same backend (needs the option "secondInstance")',
    ]);
    expect(report.passed).toContain('get() of an unknown id gives null');
  });

  it('tests expiry with a real TTL on request', { timeout: 10_000 }, async () => {
    const report = await verifyVaultStorage(() => new MemoryVaultStorage(), { realTimeExpiry: true });

    expect(report.passed).toContain('get() of an expired entry gives null');
  });
});

describe('verifyCustomEntityStore() on the built-in stores', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pii-shield-conformance-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('InMemoryCustomEntityStore', async () => {
    await verifyCustomEntityStore(() => new InMemoryCustomEntityStore());
  });

  it('JsonFileCustomEntityStore, also across two instances on one file', async () => {
    const paths = new WeakMap<CustomEntityStore, string>();
    let n = 0;
    const report = await verifyCustomEntityStore(
      () => {
        const path = join(dir, `types-${String(++n)}.json`);
        const store = new JsonFileCustomEntityStore(path);
        paths.set(store, path);

        return store;
      },
      { secondInstance: (store) => new JsonFileCustomEntityStore(paths.get(store) ?? '') },
    );

    expect(report.skipped).toEqual([]);
  });

  it('KeyValueCustomEntityStore over a map', async () => {
    const report = await verifyCustomEntityStore(() => new KeyValueCustomEntityStore(mapKeyValue()));

    expect(report.skipped).toEqual([expect.stringContaining('secondInstance')]);
  });

  it('shows that KeyValueCustomEntityStore loses concurrent writes across instances (documented)', async () => {
    const maps = new WeakMap<CustomEntityStore, Map<string, string>>();
    const error = await verifyCustomEntityStore(
      () => {
        const map = new Map<string, string>();
        const store = new KeyValueCustomEntityStore(mapKeyValue(map));
        maps.set(store, map);

        return store;
      },
      { secondInstance: (store) => new KeyValueCustomEntityStore(mapKeyValue(maps.get(store))) },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AssertionError);
    expect((error as Error).message).toMatch(
      /^CustomEntityStore contract violated: concurrent writes through two instances over the same backend are all kept\n/,
    );
  });
});

describe('the conformance suites catch broken stores', () => {
  it('names the rule an adapter breaks', async () => {
    /** Keeps the caller's array instead of a copy. */
    class SharingStorage extends MemoryVaultStorage {
      readonly #entries = new Map<string, Uint8Array>();
      override put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void> {
        this.#entries.set(id, payload);

        return super.put(id, payload, ttlSeconds);
      }
      override get(id: string): Promise<Uint8Array | null> {
        return Promise.resolve(this.#entries.get(id) ?? null);
      }
    }

    await expect(verifyVaultStorage(() => new SharingStorage())).rejects.toThrow(
      /^VaultStorage contract violated: payloads are copied in and out\n/,
    );
  });

  it('catches a TTL check that throws synchronously instead of rejecting', async () => {
    class SyncThrowing extends MemoryVaultStorage {
      override put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void> {
        if (ttlSeconds <= 0 || !Number.isInteger(ttlSeconds)) {
          throw new RangeError('bad TTL');
        }

        return super.put(id, payload, ttlSeconds);
      }
    }

    await expect(verifyVaultStorage(() => new SyncThrowing())).rejects.toThrow(/put\(\) rejects a TTL/);
  });

  it('catches all() sorted by a locale collation', async () => {
    class LocaleSorted extends InMemoryCustomEntityStore {
      override async all(): Promise<CustomEntityType[]> {
        return (await super.all()).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      }
    }

    const error = await verifyCustomEntityStore(() => new LocaleSorted()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AssertionError);
    expect((error as Error).message).toMatch(/all\(\) is sorted by name in byte order/);
    expect((error as Error).cause).toBeInstanceOf(AssertionError);
  });
});

describe.skipIf(TEST_DATABASE_URL === '')('conformance of the Postgres stores (PII_TEST_DATABASE_URL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('PostgresVaultStorage', async () => {
    const report = await verifyVaultStorage(() => new PostgresVaultStorage({ query: db.query, table: db.vaultTable }), {
      expire: async (_storage, id) => {
        const [schema, table] = db.vaultTable.split('.');
        await db.query(
          `UPDATE "${schema ?? ''}"."${table ?? ''}" SET expires_at = now() - interval '1 second' WHERE id = $1`,
          [createHash('sha256').update(id, 'utf8').digest('hex')],
        );
      },
      // Another instance over the same pool: nothing is cached per instance.
      secondInstance: () => new PostgresVaultStorage({ query: db.query, table: db.vaultTable }),
    });

    expect(report.skipped).toEqual([]);
  });

  it('PostgresCustomEntityStore, also across two instances', async () => {
    const [schema, table] = db.typesTable.split('.');
    const report = await verifyCustomEntityStore(
      async () => {
        await db.query(`TRUNCATE "${schema ?? ''}"."${table ?? ''}"`, []);

        return new PostgresCustomEntityStore({ query: db.query, table: db.typesTable });
      },
      { secondInstance: () => new PostgresCustomEntityStore({ query: db.query, table: db.typesTable }) },
    );

    expect(report.skipped).toEqual([]);
  });
});
