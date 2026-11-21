import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateVaultKey } from '../src/index.js';
import { postgresSchema } from '../src/postgres/index.js';
import { type BackgroundTask, ConfigError, serviceFromEnv } from '../src/server/config.js';
import { TEST_DATABASE_URL } from './support/postgres.js';

const KEY = Buffer.from(generateVaultKey()).toString('base64');

describe.skipIf(TEST_DATABASE_URL === '')('the service on Postgres (PII_TEST_DATABASE_URL)', () => {
  let admin: pg.Pool;
  const schema = `pii_shield_service_${randomBytes(4).toString('hex')}`;
  /** The default table names, found through the search path in the URL (as docs/server.md suggests). */
  const url = (searchPath: string) => {
    const u = new URL(TEST_DATABASE_URL);
    u.searchParams.set('options', `-c search_path=${searchPath}`);

    return u.toString();
  };
  const env = (searchPath = schema) => ({
    PII_SERVICE_VAULT_STORE: 'postgres',
    PII_SERVICE_LEARNED_STORE: 'postgres',
    PII_SERVICE_VAULT_KEY: KEY,
    PII_SERVICE_DATABASE_URL: url(searchPath),
  });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE SCHEMA "${schema}_empty"`);
    await admin.query(`SET search_path = "${schema}"; ${postgresSchema()}`);
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE; DROP SCHEMA "${schema}_empty" CASCADE`);
    await admin.end();
  });

  it('shares vault entries and learned types between instances', async () => {
    const one = await serviceFromEnv(env());
    const two = await serviceFromEnv(env());
    try {
      await one.api.operation('learn', { name: 'POLICY_NUMBER', examples: ['POL-2026-004711', 'POL-2025-000815'] });
      const redacted = (await two.api.operation('redact', { text: 'Polizze POL-2026-123456' })).body as {
        text: string;
        vaultId: string;
      };

      expect(redacted.text).toBe('Polizze ⟦POLICY_NUMBER_1⟧');
      expect((await one.api.operation('restore', { text: redacted.text, vaultId: redacted.vaultId })).body).toEqual({
        text: 'Polizze POL-2026-123456',
        unknownPlaceholders: [],
        unusedPlaceholders: [],
      });
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('purges expired vault rows at start and on its interval, and stops on close', async () => {
    const expired = async () => {
      await admin.query(
        `INSERT INTO "${schema}".pii_shield_vault VALUES ($1, '\\x00', now() - interval '1 second') ON CONFLICT DO NOTHING`,
        [randomBytes(16).toString('hex')],
      );
    };
    const count = async () =>
      Number(
        (
          await admin.query<{ n: string }>(
            `SELECT count(*) AS n FROM "${schema}".pii_shield_vault WHERE expires_at <= now()`,
          )
        ).rows[0]?.n,
      );
    await expired();
    const service = await serviceFromEnv({ ...env(), PII_SERVICE_VAULT_PURGE_INTERVAL: '1' });
    try {
      await expect.poll(count).toBe(0);
      await expired();
      await expect.poll(count, { timeout: 3000 }).toBe(0);
    } finally {
      await service.close();
    }
    await expired();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await count()).toBe(1);
  });

  it('reports purge errors to onError', async () => {
    const errors: [unknown, BackgroundTask][] = [];
    // Readable, so the start-up check passes, but FOR UPDATE and DELETE fail.
    await admin.query(
      `CREATE VIEW "${schema}_empty".pii_shield_vault AS SELECT DISTINCT ''::text AS id, ''::bytea AS payload, now() AS expires_at WHERE false`,
    );
    try {
      const service = await serviceFromEnv(
        { ...env(`${schema}_empty`), PII_SERVICE_LEARNED_STORE: 'memory' },
        { onError: (error, task) => errors.push([error, task]) },
      );
      await service.close();
    } finally {
      await admin.query(`DROP VIEW "${schema}_empty".pii_shield_vault`);
    }

    expect(errors).toEqual([[expect.any(Error), 'vault-purge']]);
  });

  it.each([
    ['-1', 'PII_SERVICE_VAULT_PURGE_INTERVAL must be an integer of at least 0.'],
    ['86401', 'PII_SERVICE_VAULT_PURGE_INTERVAL must be at most 86400 (one day).'],
  ])('rejects the purge interval %s', async (interval, message) => {
    await expect(serviceFromEnv({ ...env(), PII_SERVICE_VAULT_PURGE_INTERVAL: interval })).rejects.toThrow(
      new ConfigError(message),
    );
  });

  it('can turn the purge off', async () => {
    const service = await serviceFromEnv({ ...env(), PII_SERVICE_VAULT_PURGE_INTERVAL: '0' });
    await service.close();

    expect(service.notes).toContain(
      'Vault: expired rows are not purged (PII_SERVICE_VAULT_PURGE_INTERVAL=0); delete them yourself.',
    );
  });

  it('stops at start when a table is missing', async () => {
    const vault = await serviceFromEnv(env(`${schema}_empty`)).catch((e: unknown) => e);
    const learned = await serviceFromEnv({ ...env(`${schema}_empty`), PII_SERVICE_VAULT_STORE: 'memory' }).catch(
      (e: unknown) => e,
    );

    expect(vault).toBeInstanceOf(ConfigError);
    expect((vault as Error).message).toBe(
      'The vault table cannot be read: relation "pii_shield_vault" does not exist. Create the tables with "pii-shield db-schema".',
    );
    expect(learned).toBeInstanceOf(ConfigError);
    expect((learned as Error).message).toBe(
      'The learned types cannot be read: relation "pii_shield_learned_types" does not exist',
    );
  });
});
