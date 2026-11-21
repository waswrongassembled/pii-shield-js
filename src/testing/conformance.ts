import assert, { AssertionError } from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { type CustomEntityType, defineCustomEntityType } from '../learning/custom-entity-type.js';
import type { CustomEntityStore } from '../learning/store.js';
import type { VaultStorage } from '../vault/vault.js';

/** Which rules of a conformance suite ran and which were skipped for lack of an option. */
export interface VerifyReport {
  readonly passed: readonly string[];
  /** Rules that need an option the caller did not give (e.g. `expire`), with the option's name. */
  readonly skipped: readonly string[];
}

/** A function that returns a store; it may be async. */
type Factory<S> = () => S | Promise<S>;

export interface VerifyVaultStorageOptions<S extends VaultStorage = VaultStorage> {
  /**
   * Makes the entry `id` (written through `storage`) expired, as if its TTL had passed. Needed for the
   * expiry rules, because a backend that keeps time itself (a database's `now()`, Redis) cannot be
   * given a fake clock. Examples: advance an injected clock; for Postgres
   * `UPDATE … SET expires_at = now() - interval '1 second' WHERE id = <hashed id>`.
   * Expiring more than this entry (advancing a shared clock) is fine.
   */
  expire?: (storage: S, id: string) => void | Promise<void>;
  /**
   * Without `expire`: test expiry with a real TTL of 1 second and a wait of 1.5 seconds. Slow, so it
   * is opt-in. Without either option the expiry rules are skipped (see the report).
   */
  realTimeExpiry?: boolean;
  /**
   * Another instance over the same backend as `storage` (another connection, another process's
   * view). Enables the rule that entries written through one instance are read through another.
   */
  secondInstance?: (storage: S) => VaultStorage | Promise<VaultStorage>;
}

export interface VerifyCustomEntityStoreOptions<S extends CustomEntityStore = CustomEntityStore> {
  /**
   * Another instance over the same backend as `store`. Enables the rule that concurrent writes of
   * different names through two instances are all kept (which KeyValueCustomEntityStore does not do).
   */
  secondInstance?: (store: S) => CustomEntityStore | Promise<CustomEntityStore>;
}

interface Rule {
  readonly name: string;
  /** The option the rule needs, if it was not given. */
  readonly missing?: string | undefined;
  run(): Promise<void>;
}

/**
 * Checks that a VaultStorage keeps the contract documented on the interface: unknown and expired ids
 * give null, payloads are binary-safe and copied, put() overwrites, remove() of an unknown id is a
 * no-op, TTLs are validated, ids are independent of each other.
 *
 * `factory` is called once per rule. Instances may share one backend: the ids of a run are random,
 * so a shared database or Redis needs no cleanup between rules. Data is synthetic.
 *
 * Runs under any test runner: `await verifyVaultStorage(() => new MyStorage())` inside a test.
 *
 * @returns which rules passed and which were skipped for lack of an option
 * @throws AssertionError naming the first rule that failed (the original error is its `cause`)
 */
export async function verifyVaultStorage<S extends VaultStorage>(
  factory: Factory<S>,
  options: VerifyVaultStorageOptions<S> = {},
): Promise<VerifyReport> {
  const { expire, realTimeExpiry = false, secondInstance } = options;
  const run = randomBytes(6).toString('hex');
  const id = (name: string): string => `pii-shield-conformance-${run}-${name}`;
  const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
  const assertBytes = (actual: Uint8Array | null, expected: Uint8Array, what: string): void => {
    assert.ok(actual instanceof Uint8Array, `${what}: expected a Uint8Array, got ${describe(actual)}`);
    assert.deepEqual(new Uint8Array(actual), expected, what);
  };
  const canExpire = expire !== undefined || realTimeExpiry;
  /** Puts an entry and makes it expire, by the hook or by waiting. */
  const putExpired = async (storage: S, key: string, payload: Uint8Array): Promise<void> => {
    if (expire !== undefined) {
      await storage.put(key, payload, 60);
      await expire(storage, key);
    } else {
      await storage.put(key, payload, 1);
      await sleep(1500);
    }
  };

  const rules: Rule[] = [
    {
      name: 'get() of an unknown id gives null',
      run: async () => {
        assert.equal(await (await factory()).get(id('unknown')), null);
      },
    },
    {
      name: 'put() then get() gives the payload back',
      run: async () => {
        const storage = await factory();
        const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
        await storage.put(id('a'), payload, 60);
        assertBytes(await storage.get(id('a')), payload, 'every byte value 0..255');
      },
    },
    {
      name: 'payloads of any length are binary-safe',
      run: async () => {
        const storage = await factory();
        const cases: [string, Uint8Array][] = [
          ['empty', new Uint8Array(0)],
          ['zero bytes', new Uint8Array(32)],
          ['invalid UTF-8', bytes(0xc3, 0x28, 0xff, 0xfe, 0x00, 0xed, 0xa0, 0x80)],
          ['64 KiB', new Uint8Array(randomBytes(64 * 1024))],
        ];
        for (const [name, payload] of cases) {
          await storage.put(id(name), payload, 60);
        }
        for (const [name, payload] of cases) {
          assertBytes(await storage.get(id(name)), payload, name);
        }
      },
    },
    {
      name: 'put() stores only the bytes of a view, not its whole buffer',
      run: async () => {
        const storage = await factory();
        await storage.put(id('view'), bytes(9, 1, 2, 3, 9).subarray(1, 4), 60);
        assertBytes(await storage.get(id('view')), bytes(1, 2, 3), 'subarray(1, 4)');
      },
    },
    {
      name: 'payloads are copied in and out',
      run: async () => {
        const storage = await factory();
        const payload = bytes(1, 2, 3);
        await storage.put(id('copy'), payload, 60);
        payload.fill(0);
        const first = await storage.get(id('copy'));
        assertBytes(first, bytes(1, 2, 3), 'after changing the array passed to put()');
        first?.fill(0);
        assertBytes(await storage.get(id('copy')), bytes(1, 2, 3), 'after changing the array get() returned');
      },
    },
    {
      name: 'put() overwrites an existing entry',
      run: async () => {
        const storage = await factory();
        await storage.put(id('overwrite'), bytes(1), 60);
        await storage.put(id('overwrite'), bytes(2, 2), 120);
        assertBytes(await storage.get(id('overwrite')), bytes(2, 2), 'second put()');
      },
    },
    {
      name: 'ids are independent and may contain any characters',
      run: async () => {
        const storage = await factory();
        const ids = [
          'id-1',
          'ID-1',
          'id-1 ',
          '',
          'ü-✓-😀',
          'a/b:c@d*?%_\\',
          "x'; DELETE FROM vault; --",
          '\u0000nul',
          'x'.repeat(2000),
        ].map((suffix) => id(suffix));
        for (const [i, key] of ids.entries()) {
          await storage.put(key, bytes(i, 0xff), 60);
        }
        for (const [i, key] of ids.entries()) {
          assertBytes(await storage.get(key), bytes(i, 0xff), `id #${String(i + 1)}`);
        }
      },
    },
    {
      name: 'remove() deletes only its entry, remove() of an unknown id is a no-op',
      run: async () => {
        const storage = await factory();
        await storage.put(id('keep'), bytes(1), 60);
        await storage.put(id('remove'), bytes(2), 60);
        await storage.remove(id('remove'));
        await storage.remove(id('remove'));
        await storage.remove(id('never-stored'));
        assert.equal(await storage.get(id('remove')), null, 'removed entry');
        assertBytes(await storage.get(id('keep')), bytes(1), 'other entry');
      },
    },
    {
      name: 'put() rejects a TTL that is not a positive integer, and stores nothing',
      run: async () => {
        const storage = await factory();
        for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          await assert.rejects(
            () => storage.put(id('ttl'), bytes(1), ttl),
            (e: unknown) => e instanceof RangeError || e instanceof TypeError,
            `TTL ${String(ttl)} must reject the Promise with a RangeError or TypeError`,
          );
        }
        assert.equal(await storage.get(id('ttl')), null);
      },
    },
    {
      name: 'get() of an expired entry gives null',
      missing: canExpire ? undefined : 'expire',
      run: async () => {
        const storage = await factory();
        await putExpired(storage, id('expired'), bytes(1));
        assert.equal(await storage.get(id('expired')), null);
      },
    },
    {
      name: 'put() over an expired entry stores it again',
      missing: canExpire ? undefined : 'expire',
      run: async () => {
        const storage = await factory();
        await putExpired(storage, id('again'), bytes(1));
        await storage.put(id('again'), bytes(2), 60);
        assertBytes(await storage.get(id('again')), bytes(2), 'second put()');
      },
    },
    {
      name: 'entries are shared between instances over the same backend',
      missing: secondInstance === undefined ? 'secondInstance' : undefined,
      run: async () => {
        if (secondInstance === undefined) {
          return; // skipped, see missing
        }
        const storage = await factory();
        const other = await secondInstance(storage);
        await storage.put(id('shared'), bytes(7), 60);
        assertBytes(await other.get(id('shared')), bytes(7), 'read through the second instance');
        await other.remove(id('shared'));
        assert.equal(await storage.get(id('shared')), null, 'removed through the second instance');
      },
    },
  ];

  return runRules('VaultStorage', rules);
}

/**
 * Checks that a CustomEntityStore keeps the contract documented on the interface: get() and save()
 * round-trip types exactly, save() replaces, all() is sorted by name in byte order, remove() of an
 * unknown name is a no-op, and concurrent writes of different names are all kept.
 *
 * `factory` is called once per rule and must return an empty store (e.g. truncate the table first).
 * Data is synthetic.
 *
 * @returns which rules passed and which were skipped for lack of an option
 * @throws AssertionError naming the first rule that failed (the original error is its `cause`)
 */
export async function verifyCustomEntityStore<S extends CustomEntityStore>(
  factory: Factory<S>,
  options: VerifyCustomEntityStoreOptions<S> = {},
): Promise<VerifyReport> {
  const { secondInstance } = options;
  const names = (types: readonly CustomEntityType[]): string[] => types.map((t) => t.name);

  const rules: Rule[] = [
    {
      name: 'all() of an empty store gives [] (the factory must return an empty store)',
      run: async () => {
        assert.deepEqual(await (await factory()).all(), []);
      },
    },
    {
      name: 'get() of an unknown name gives null',
      run: async () => {
        assert.equal(await (await factory()).get('UNKNOWN_TYPE'), null);
      },
    },
    {
      name: 'save() then get() and all() give the type back unchanged',
      run: async () => {
        const store = await factory();
        const types = [syntheticType('TEST_CODE'), richType()];
        for (const type of types) {
          await store.save(type);
        }
        for (const type of types) {
          assert.deepEqual(await store.get(type.name), type, type.name);
        }
        assert.deepEqual(await store.all(), sortedByByteOrder(types));
      },
    },
    {
      name: 'save() replaces the type with the same name',
      run: async () => {
        const store = await factory();
        await store.save(syntheticType('TEST_CODE'));
        const replacement = syntheticType('TEST_CODE', 'Replaced synthetic test type');
        await store.save(replacement);
        assert.deepEqual(await store.get('TEST_CODE'), replacement);
        assert.deepEqual(await store.all(), [replacement]);
      },
    },
    {
      name: 'all() is sorted by name in byte order',
      run: async () => {
        const store = await factory();
        // A locale collation would sort A_CODE before AB_CODE and B_CODE before B2_CODE.
        for (const name of ['ZETA_CODE', 'A_CODE', 'B_CODE', 'AB_CODE', 'B2_CODE']) {
          await store.save(syntheticType(name));
        }
        assert.deepEqual(names(await store.all()), ['AB_CODE', 'A_CODE', 'B2_CODE', 'B_CODE', 'ZETA_CODE']);
      },
    },
    {
      name: 'remove() deletes only its type, remove() of an unknown name is a no-op',
      run: async () => {
        const store = await factory();
        await store.save(syntheticType('KEEP_CODE'));
        await store.save(syntheticType('DROP_CODE'));
        await store.remove('DROP_CODE');
        await store.remove('DROP_CODE');
        await store.remove('NEVER_SAVED');
        assert.equal(await store.get('DROP_CODE'), null, 'removed type');
        assert.deepEqual(names(await store.all()), ['KEEP_CODE']);
      },
    },
    {
      name: 'concurrent writes of different names are all kept',
      run: async () => {
        const store = await factory();
        await Promise.all(range(8).map((i) => store.save(syntheticType(`CODE_${String(i)}`))));
        assert.deepEqual(
          names(await store.all()),
          range(8).map((i) => `CODE_${String(i)}`),
        );
        await Promise.all([
          ...range(4).map((i) => store.remove(`CODE_${String(i)}`)),
          ...range(4).map((i) => store.save(syntheticType(`NEW_${String(i)}`))),
        ]);
        assert.deepEqual(names(await store.all()), [
          ...range(4).map((i) => `CODE_${String(i + 4)}`),
          ...range(4).map((i) => `NEW_${String(i)}`),
        ]);
      },
    },
    {
      name: 'concurrent writes through two instances over the same backend are all kept',
      missing: secondInstance === undefined ? 'secondInstance' : undefined,
      run: async () => {
        if (secondInstance === undefined) {
          return; // skipped, see missing
        }
        const store = await factory();
        const other = await secondInstance(store);
        await Promise.all(range(8).map((i) => (i % 2 === 0 ? store : other).save(syntheticType(`CODE_${String(i)}`))));
        assert.deepEqual(
          names(await store.all()),
          range(8).map((i) => `CODE_${String(i)}`),
        );
        assert.deepEqual(
          names(await other.all()),
          range(8).map((i) => `CODE_${String(i)}`),
        );
      },
    },
  ];

  return runRules('CustomEntityStore', rules);
}

async function runRules(contract: string, rules: readonly Rule[]): Promise<VerifyReport> {
  const passed: string[] = [];
  const skipped: string[] = [];
  for (const rule of rules) {
    if (rule.missing !== undefined) {
      skipped.push(`${rule.name} (needs the option "${rule.missing}")`);
      continue;
    }
    try {
      await rule.run();
    } catch (e) {
      const inner = e instanceof AssertionError ? e : undefined;
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      const error = new AssertionError({
        message: `${contract} contract violated: ${rule.name}\n${detail}`,
        actual: inner?.actual,
        expected: inner?.expected,
        operator: inner?.operator ?? 'fail',
      });
      error.cause = e;
      throw error;
    }
    passed.push(rule.name);
  }

  return { passed, skipped };
}

function syntheticType(name: string, description = 'Synthetic test type'): CustomEntityType {
  return defineCustomEntityType({ name, description, examples: ['TST-0001', 'TST-0002'], pattern: null });
}

/** A type with a pattern and characters that JSON, jsonb and text encodings must keep. */
function richType(): CustomEntityType {
  return defineCustomEntityType({
    name: 'RICH_TEST_CODE',
    description: 'Synthetische Testart: "Zitat" \\ / & ü ✓ 😀   Ende',
    examples: ['TST-0001', 'TST-9999'],
    counterExamples: ['TSX-0001', 'Ölbaum "Nord" \\ 7 😀  '],
    pattern: String.raw`TST-\d{4}`,
  });
}

function sortedByByteOrder(types: readonly CustomEntityType[]): CustomEntityType[] {
  return [...types].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function describe(value: unknown): string {
  return value === null ? 'null' : typeof value === 'object' ? value.constructor.name : typeof value;
}
