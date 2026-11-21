import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { postgresSchema, type PostgresQuery } from '../../src/postgres/index.js';

/** Integration tests run only with a throwaway database in PII_TEST_DATABASE_URL (CI: a service container). */
export const TEST_DATABASE_URL = process.env['PII_TEST_DATABASE_URL'] ?? '';

export interface TestDatabase {
  pool: pg.Pool;
  query: PostgresQuery;
  /** Schema-qualified table names in this run's own schema. */
  vaultTable: string;
  typesTable: string;
  close(): Promise<void>;
}

/** A pool and a fresh schema with both tables (from postgresSchema()), dropped again by close(). */
export async function testDatabase(): Promise<TestDatabase> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  const schema = `pii_shield_test_${randomBytes(4).toString('hex')}`;
  const vaultTable = `${schema}.vault`;
  const typesTable = `${schema}.learned_types`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  await pool.query(postgresSchema({ vaultTable, typesTable }));

  return {
    pool,
    query: pool.query.bind(pool),
    vaultTable,
    typesTable,
    close: async () => {
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}
