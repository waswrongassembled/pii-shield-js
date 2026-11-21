import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import {
  defineCustomEntityType,
  EncryptedVault,
  EntityLearner,
  generateVaultKey,
  LearningError,
  PiiShieldError,
  VaultError,
} from '../src/index.js';
import {
  PostgresCustomEntityStore,
  type PostgresQuery,
  type PostgresQueryResult,
  postgresSchema,
  PostgresVaultStorage,
} from '../src/postgres/index.js';
import { TEST_DATABASE_URL, type TestDatabase, testDatabase } from './support/postgres.js';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Records every statement and answers with the queued results (default: no rows). */
function fakeQuery(...results: PostgresQueryResult[]) {
  const calls: { text: string; params: unknown[] }[] = [];
  const query: PostgresQuery = (text, params) => {
    calls.push({ text, params });

    return Promise.resolve(results.shift() ?? { rows: [] });
  };

  return { calls, query };
}

const policyNumber = () =>
  defineCustomEntityType({
    name: 'POLICY_NUMBER',
    description: 'Synthetische Polizzennummer',
    examples: ['POL-2026-004711'],
    pattern: String.raw`POL-\d{4}-\d{6}`,
  });

describe('PostgresQuery', () => {
  it('accepts pg’s Pool and PoolClient query, bound or wrapped', () => {
    // Type-level only (tsc checks it); never called.
    const check = (pool: Pool, client: PoolClient) => {
      expectTypeOf(pool.query.bind(pool)).toExtend<PostgresQuery>();
      expectTypeOf(client.query.bind(client)).toExtend<PostgresQuery>();
      expectTypeOf((text: string, params: unknown[]) => pool.query(text, params)).toExtend<PostgresQuery>();
      expectTypeOf((text: string) => pool.query(text)).toExtend<PostgresQuery>();
      expectTypeOf((text: number) => pool.query(String(text))).not.toExtend<PostgresQuery>();
    };
    expect(check).toBeTypeOf('function');
  });
});

describe('PostgresVaultStorage (fake query)', () => {
  it('upserts with the database clock, under the sha256 of the id', async () => {
    const { calls, query } = fakeQuery();
    const payload = Uint8Array.of(9, 0, 255, 9);

    await new PostgresVaultStorage({ query }).put('id-1', payload.subarray(1, 3), 60);

    expect(calls).toEqual([
      {
        text:
          'INSERT INTO "pii_shield_vault" (id, payload, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) ' +
          'ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at',
        params: [sha256('id-1'), Buffer.from([0, 255]), 60],
      },
    ]);
  });

  it('reads only unexpired rows and returns a copy as Uint8Array', async () => {
    const stored = Buffer.from([1, 2, 3]);
    const { calls, query } = fakeQuery({ rows: [{ payload: stored }] }, { rows: [] });
    const storage = new PostgresVaultStorage({ query, table: 'app.vault' });

    const payload = await storage.get('id-1');
    stored.fill(0);

    expect(payload).toEqual(Uint8Array.of(1, 2, 3));
    expect(payload).not.toBeInstanceOf(Buffer);
    expect(await storage.get('id-2')).toBeNull();
    expect(calls).toEqual([
      { text: 'SELECT payload FROM "app"."vault" WHERE id = $1 AND expires_at > now()', params: [sha256('id-1')] },
      { text: 'SELECT payload FROM "app"."vault" WHERE id = $1 AND expires_at > now()', params: [sha256('id-2')] },
    ]);
  });

  it('rejects a payload that is not binary with a fixed message', async () => {
    const { query } = fakeQuery({ rows: [{ payload: '\\x0102' }] });

    const error = await new PostgresVaultStorage({ query }).get('id-1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VaultError);
    expect(error).toMatchObject({
      code: 'VAULT_CORRUPT',
      message: 'The vault table returned a payload that is not binary (bytea).',
    });
  });

  it('removes by hashed id', async () => {
    const { calls, query } = fakeQuery();

    await new PostgresVaultStorage({ query }).remove("x'; --");

    expect(calls).toEqual([{ text: 'DELETE FROM "pii_shield_vault" WHERE id = $1', params: [sha256("x'; --")] }]);
  });

  it('purges expired rows and returns the count', async () => {
    const { calls, query } = fakeQuery({ rows: [{ deleted: '42' }] }, { rows: [{ deleted: 0n }] }, { rows: [] });
    const storage = new PostgresVaultStorage({ query });

    expect(await storage.purgeExpired()).toBe(42);
    expect(await storage.purgeExpired()).toBe(0);
    expect(await storage.purgeExpired()).toBe(0);
    expect(calls[0]).toEqual({
      text:
        'WITH expired AS (SELECT id FROM "pii_shield_vault" WHERE expires_at <= now() FOR UPDATE SKIP LOCKED), ' +
        'deleted AS (DELETE FROM "pii_shield_vault" AS t USING expired WHERE t.id = expired.id RETURNING 1) ' +
        'SELECT count(*) AS deleted FROM deleted',
      params: [],
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects TTL %s before querying', async (ttl) => {
    const { calls, query } = fakeQuery();

    await expect(new PostgresVaultStorage({ query }).put('id-1', Uint8Array.of(1), ttl)).rejects.toThrow(
      /The TTL must be/,
    );
    expect(calls).toEqual([]);
  });
});

describe('PostgresCustomEntityStore (fake query)', () => {
  it('upserts one row per type with its JSON', async () => {
    const { calls, query } = fakeQuery();
    const type = policyNumber();

    await new PostgresCustomEntityStore({ query }).save(type);

    expect(calls).toEqual([
      {
        text: 'INSERT INTO "pii_shield_learned_types" (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data',
        params: ['POLICY_NUMBER', JSON.stringify(type)],
      },
    ]);
  });

  it('validates rows, also jsonb returned as text, and sorts in byte order', async () => {
    const row = (name: string) => ({
      name,
      data: { ...JSON.parse(JSON.stringify(policyNumber())), name } as unknown,
    });
    const { calls, query } = fakeQuery(
      { rows: [row('B_CODE'), row('B2_CODE'), { name: 'A_CODE', data: JSON.stringify(row('A_CODE').data) }] },
      { rows: [row('B_CODE')] },
    );
    const store = new PostgresCustomEntityStore({ query, table: 'Custom_Types' });

    expect((await store.all()).map((t) => t.name)).toEqual(['A_CODE', 'B2_CODE', 'B_CODE']);
    expect(await store.get('B_CODE')).toMatchObject({ name: 'B_CODE', pattern: String.raw`POL-\d{4}-\d{6}` });
    expect(await store.get('C_CODE')).toBeNull();
    expect(calls.map((c) => c.text)).toEqual([
      'SELECT name, data FROM "Custom_Types"',
      'SELECT name, data FROM "Custom_Types" WHERE name = $1',
      'SELECT name, data FROM "Custom_Types" WHERE name = $1',
    ]);
  });

  it.each([
    ['unparsable text', { name: 'A_CODE', data: '{"name":"A_CODE", Maria Musterfrau' }],
    ['not an object', { name: 'A_CODE', data: 7 }],
    [
      'a name that differs from the row',
      { name: 'A_CODE', data: JSON.parse(JSON.stringify(policyNumber())) as unknown },
    ],
    ['no columns', null],
  ])('rejects a row with %s, without quoting it', async (_, row) => {
    const { query } = fakeQuery({ rows: [row] });

    const error = await new PostgresCustomEntityStore({ query }).all().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PiiShieldError);
    expect(error).toMatchObject({
      code: 'LEARNING_STORE_CORRUPT',
      message: 'The learned types table contains a row that is not a learned type.',
    });
    expect((error as Error).cause).toBeUndefined();
  });

  it('rejects an invalid stored type with the validation message', async () => {
    const { query } = fakeQuery({ rows: [{ name: 'A_CODE', data: { name: 'A_CODE', examples: [] } }] });

    await expect(new PostgresCustomEntityStore({ query }).all()).rejects.toThrow(LearningError);
  });

  it('removes by name', async () => {
    const { calls, query } = fakeQuery();

    await new PostgresCustomEntityStore({ query }).remove('POLICY_NUMBER');

    expect(calls).toEqual([
      { text: 'DELETE FROM "pii_shield_learned_types" WHERE name = $1', params: ['POLICY_NUMBER'] },
    ]);
  });
});

describe('table names', () => {
  it.each([
    'vault"; DROP TABLE x; --',
    'a.b.c',
    '',
    '.vault',
    'vault.',
    '1vault',
    'vault-table',
    'väult',
    'a'.repeat(49),
    ' vault',
  ])('rejects %j in every constructor and in postgresSchema()', (table) => {
    const { query } = fakeQuery();
    const message =
      'The table name must be an identifier ([A-Za-z_][A-Za-z0-9_]*, at most 48 characters), optionally schema-qualified (schema.table).';

    expect(() => new PostgresVaultStorage({ query, table })).toThrow(new RangeError(message));
    expect(() => new PostgresCustomEntityStore({ query, table })).toThrow(new RangeError(message));
    expect(() => postgresSchema({ vaultTable: table })).toThrow(new RangeError(message));
    expect(() => postgresSchema({ typesTable: table })).toThrow(new RangeError(message));
  });

  it('rejects a table name that is not a string', () => {
    expect(() => new PostgresVaultStorage({ query: fakeQuery().query, table: 7 as unknown as string })).toThrow(
      TypeError,
    );
  });
});

describe('postgresSchema()', () => {
  it('returns idempotent DDL for both tables', () => {
    expect(postgresSchema()).toBe(`CREATE TABLE IF NOT EXISTS "pii_shield_vault" (
    id text PRIMARY KEY,
    payload bytea NOT NULL,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "pii_shield_vault_expires_at_idx" ON "pii_shield_vault" (expires_at);
COMMENT ON TABLE "pii_shield_vault" IS 'pii-shield vault: encrypted placeholder mappings (ciphertext only). Delete expired rows regularly (purgeExpired()).';
CREATE TABLE IF NOT EXISTS "pii_shield_learned_types" (
    name text PRIMARY KEY,
    data jsonb NOT NULL
);
COMMENT ON TABLE "pii_shield_learned_types" IS 'pii-shield learned entity types. Examples are plain text and may be personal data.';
`);
  });

  it('takes schema-qualified names and leaves out a table set to null', () => {
    const ddl = postgresSchema({ vaultTable: 'app.Vault', typesTable: null });

    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "app"."Vault" (');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS "Vault_expires_at_idx" ON "app"."Vault" (expires_at);');
    expect(ddl).not.toContain('learned');
    expect(postgresSchema({ vaultTable: null, typesTable: null })).toBe('\n');
  });
});

describe.skipIf(TEST_DATABASE_URL === '')('Postgres stores on a real database (PII_TEST_DATABASE_URL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('applies the DDL twice without error', async () => {
    await db.query(postgresSchema({ vaultTable: db.vaultTable, typesTable: db.typesTable }), []);
  });

  it('stores only ciphertext behind EncryptedVault, under the hashed id', async () => {
    const vault = new EncryptedVault({
      storage: new PostgresVaultStorage({ query: db.query, table: db.vaultTable }),
      key: generateVaultKey(),
    });

    await vault.store('vault-id-1', { '⟦PERSON_1⟧': 'Maria Musterfrau' }, 60);

    expect(await vault.fetch('vault-id-1')).toEqual({ '⟦PERSON_1⟧': 'Maria Musterfrau' });
    const { rows } = await db.pool.query<{ id: string; payload: Buffer }>(
      `SELECT id, payload FROM ${quoted(db.vaultTable)} WHERE id = $1`,
      [sha256('vault-id-1')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.includes('Maria')).toBe(false);
  });

  it('expires by the database clock and purges expired rows', async () => {
    const storage = new PostgresVaultStorage({ query: db.query, table: db.vaultTable });
    await storage.put('purge-1', Uint8Array.of(1), 60);
    await storage.put('purge-2', Uint8Array.of(2), 60);
    await storage.put('purge-keep', Uint8Array.of(3), 60);
    await db.query(`UPDATE ${quoted(db.vaultTable)} SET expires_at = now() - interval '1 second' WHERE id = ANY($1)`, [
      [sha256('purge-1'), sha256('purge-2')],
    ]);

    expect(await storage.get('purge-1')).toBeNull();
    expect(await storage.purgeExpired()).toBe(2);
    expect(await storage.purgeExpired()).toBe(0);
    const { rows } = await db.pool.query(`SELECT id FROM ${quoted(db.vaultTable)} WHERE id = ANY($1)`, [
      [sha256('purge-1'), sha256('purge-2'), sha256('purge-keep')],
    ]);
    expect(rows).toEqual([{ id: sha256('purge-keep') }]);
    expect(await storage.get('purge-keep')).toEqual(Uint8Array.of(3));
  });

  it('takes part in the caller’s transaction', async () => {
    const client = await db.pool.connect();
    try {
      const query = client.query.bind(client);
      const vault = new PostgresVaultStorage({ query, table: db.vaultTable });
      const types = new PostgresCustomEntityStore({ query, table: db.typesTable });
      await client.query('BEGIN');
      await vault.put('tx-1', Uint8Array.of(1), 60);
      await types.save(policyNumber());
      expect(await vault.get('tx-1')).toEqual(Uint8Array.of(1));
      expect(await types.get('POLICY_NUMBER')).not.toBeNull();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(await new PostgresVaultStorage({ query: db.query, table: db.vaultTable }).get('tx-1')).toBeNull();
    expect(
      await new PostgresCustomEntityStore({ query: db.query, table: db.typesTable }).get('POLICY_NUMBER'),
    ).toBeNull();
  });

  it('keeps learned types for an EntityLearner in jsonb', async () => {
    const store = new PostgresCustomEntityStore({ query: db.query, table: db.typesTable });
    const learner = await EntityLearner.create({ store });
    await learner.learn({ name: 'POLICY_NUMBER', description: 'Synthetisch', examples: ['POL-2026-004711'] });

    const other = await EntityLearner.create({
      store: new PostgresCustomEntityStore({ query: db.query, table: db.typesTable }),
    });
    expect(other.snapshot.map((t) => t.name)).toEqual(['POLICY_NUMBER']);
    const { rows } = await db.pool.query<{ data: unknown }>(`SELECT data FROM ${quoted(db.typesTable)}`);
    expect(rows[0]?.data).toMatchObject({ name: 'POLICY_NUMBER', examples: ['POL-2026-004711'] });

    await learner.forget('POLICY_NUMBER');
    expect(await store.all()).toEqual([]);
  });
});

function quoted(table: string): string {
  return table
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}
