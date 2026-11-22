import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { generateVaultKey } from '../src/index.js';
import { postgresSchema } from '../src/postgres/index.js';
import { checkServiceConfig, type ConfigFinding, formatFindings } from '../src/server/index.js';
import { TEST_DATABASE_URL } from './support/postgres.js';

const KEY = Buffer.from(generateVaultKey()).toString('base64');
const TOKEN = 'synthetic-token-0123456789abcdef0123456789';
const PASSWORD = 's3cret-pw-synthetic';

afterEach(() => {
  vi.restoreAllMocks();
});

/** severity and check of each finding, for compact assertions. */
const summary = (findings: readonly ConfigFinding[]) => findings.map((f) => `${f.severity} ${f.check}`);
const find = (findings: readonly ConfigFinding[], check: string) => findings.filter((f) => f.check === check);

describe('checkServiceConfig', () => {
  it('passes the defaults with notes and a warning about the missing token', async () => {
    const findings = await checkServiceConfig({});

    expect(summary(findings)).toEqual([
      'info vault-key',
      'info vault-store',
      'ok vault-ttl',
      'warning token',
      'ok listen',
      'info learned-store',
      'info learned-examples',
      'info model',
    ]);
  });

  it('finds nothing to complain about in a hardened configuration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pii-shield-doctor-'));
    try {
      const findings = await checkServiceConfig({
        PII_SERVICE_TOKEN: TOKEN,
        PII_SERVICE_ONLY: '1',
        PII_SERVICE_VAULT_KEY: KEY,
        PII_SERVICE_VAULT_STORE: 'postgres',
        PII_SERVICE_DATABASE_URL: `postgres://app:${PASSWORD}@db.internal/app?sslmode=verify-full`,
        PII_SERVICE_LEARNED_TYPES: join(dir, 'learned-types.json'),
        PII_SERVICE_LEARNED_KEEP_EXAMPLES: 'false',
        PII_SERVICE_MODEL_PROVIDER: 'ollama',
      });

      expect(findings.filter((f) => f.severity === 'error' || f.severity === 'warning')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('never puts a secret into a finding', async () => {
    const env = {
      PII_SERVICE_TOKEN: 'short-synthetic-token',
      PII_SERVICE_VAULT_KEY: 'bm90LWEta2V5LXN5bnRoZXRpYw==',
      PII_SERVICE_VAULT_PREVIOUS_KEYS: `${KEY},c3ludGhldGljLXByZXZpb3Vz`,
      PII_SERVICE_VAULT_STORE: 'postgres',
      PII_SERVICE_LEARNED_STORE: 'redis',
      PII_SERVICE_DATABASE_URL: `postgres://app:${PASSWORD}@db.example.internal:5432/app`,
      PII_SERVICE_REDIS_URL: `redis://:${PASSWORD}@redis.example.internal:6379`,
      PII_SERVICE_MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-synthetic-provider-key',
    };
    const findings = await checkServiceConfig(env);
    const text = formatFindings(findings) + JSON.stringify(findings);

    for (const secret of [
      env.PII_SERVICE_TOKEN,
      env.PII_SERVICE_VAULT_KEY,
      KEY,
      'c3ludGhldGljLXByZXZpb3Vz',
      PASSWORD,
      'db.example.internal',
      'redis.example.internal',
      env.ANTHROPIC_API_KEY,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(summary(findings.filter((f) => f.severity === 'error'))).toEqual([
      'error vault-key',
      'error vault-previous-keys',
      'error database-tls',
      'error model',
    ]);
  });

  it.each([
    [
      { PII_SERVICE_ONLY: '1' },
      'token',
      'PII_SERVICE_ONLY=1 without PII_SERVICE_TOKEN: every request is answered with 503.',
    ],
    [
      { PII_SERVICE_VAULT_STORE: 'redis', PII_SERVICE_REDIS_URL: 'redis://127.0.0.1:6379' },
      'vault-key',
      'The redis vault store needs PII_SERVICE_VAULT_KEY, or mappings cannot be read after a restart.',
    ],
    [
      { PII_SERVICE_VAULT_STORE: 'postgres', PII_SERVICE_VAULT_KEY: KEY },
      'database-url',
      'Set PII_SERVICE_DATABASE_URL to use the postgres store.',
    ],
    [
      { PII_SERVICE_LEARNED_STORE: 'postgres', PII_SERVICE_DATABASE_URL: `mysql://app:${PASSWORD}@db/app` },
      'database-url',
      'PII_SERVICE_DATABASE_URL must be a postgres:// or postgresql:// URL.',
    ],
    [
      { PII_SERVICE_LEARNED_STORE: 'postgres', PII_SERVICE_DATABASE_URL: 'postgres://app@db.internal/app' },
      'database-tls',
      'The database is not on this machine and PII_SERVICE_DATABASE_URL has no sslmode: TLS is not enforced. Add sslmode=verify-full (at least require).',
    ],
    [
      {
        PII_SERVICE_LEARNED_STORE: 'postgres',
        PII_SERVICE_DATABASE_URL: 'postgres://app@db.internal/app?sslmode=prefer',
      },
      'database-tls',
      'The database is not on this machine and PII_SERVICE_DATABASE_URL has sslmode=prefer: TLS is not enforced. Add sslmode=verify-full (at least require).',
    ],
    [
      {
        PII_SERVICE_VAULT_STORE: 'postgres',
        PII_SERVICE_VAULT_KEY: KEY,
        PII_SERVICE_DATABASE_URL: 'postgres://db/a',
        PII_SERVICE_VAULT_PURGE_INTERVAL: '86401',
      },
      'vault-purge',
      'PII_SERVICE_VAULT_PURGE_INTERVAL must be at most 86400 (one day).',
    ],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'mistral', MISTRAL_API_KEY: 'synthetic' },
      'model',
      'mistral is an external provider: detection sends the unredacted text there. Set PII_SERVICE_ACKNOWLEDGE_EXTERNAL=true after checking the data processing agreement and third-country transfers.',
    ],
    [{ PII_SERVICE_VAULT_TTL: '0' }, 'vault-ttl', 'PII_SERVICE_VAULT_TTL must be an integer of at least 1.'],
    [{ PII_SERVICE_PORT: '80a' }, 'listen', 'PII_SERVICE_PORT must be an integer of at least 0.'],
    [
      { PII_SERVICE_LEARNED_KEEP_EXAMPLES: 'no' },
      'learned-examples',
      'PII_SERVICE_LEARNED_KEEP_EXAMPLES must be "true" or "false".',
    ],
    [
      { PII_SERVICE_LEARNED_TYPES: '/nonexistent-pii-shield-dir/learned.json' },
      'learned-store',
      'PII_SERVICE_LEARNED_TYPES does not exist and its directory is missing or not writable.',
    ],
  ])('reports the error of %j', async (env, check, message) => {
    const findings = await checkServiceConfig(env);

    expect(find(findings, check)).toContainEqual({ severity: 'error', check, message });
  });

  it.each([
    [{ PII_SERVICE_VAULT_TTL: '7200' }, 'vault-ttl'],
    [{ PII_SERVICE_TOKEN: 'too-short' }, 'token'],
    [{ PII_SERVICE_HOST: '0.0.0.0' }, 'listen'],
    [{ PII_SERVICE_VAULT_KEY: KEY, PII_SERVICE_VAULT_PREVIOUS_KEYS: KEY }, 'vault-previous-keys'],
    [
      {
        PII_SERVICE_VAULT_STORE: 'postgres',
        PII_SERVICE_VAULT_KEY: KEY,
        PII_SERVICE_DATABASE_URL: 'postgres://app@db.internal/app?sslmode=require',
        PII_SERVICE_VAULT_PURGE_INTERVAL: '0',
      },
      'vault-purge',
    ],
    [
      {
        PII_SERVICE_LEARNED_STORE: 'postgres',
        PII_SERVICE_DATABASE_URL: 'postgres://app@db.internal/app?sslmode=require',
      },
      'database-tls',
    ],
    [{ PII_SERVICE_LEARNED_STORE: 'redis', PII_SERVICE_REDIS_URL: 'redis://redis.internal:6379' }, 'redis-tls'],
    [{ PII_SERVICE_LEARNED_STORE: 'redis', PII_SERVICE_REDIS_URL: 'redis://redis.internal:6379' }, 'learned-examples'],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'synthetic', PII_SERVICE_ACKNOWLEDGE_EXTERNAL: 'true' },
      'model',
    ],
    [{ PII_SERVICE_MODEL_PROVIDER: 'ollama', PII_SERVICE_MODEL_URL: 'http://gpu.internal:11434' }, 'model'],
  ])('warns about %j', async (env, check) => {
    const findings = await checkServiceConfig(env);

    expect(find(findings, check).map((f) => f.severity)).toContain('warning');
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('treats local databases, sockets and PGSSLMODE as fine', async () => {
    for (const url of [
      'postgres://app@localhost/app',
      'postgres://app@127.0.0.1:5432/app',
      'postgresql:///app?host=/var/run/postgresql',
    ]) {
      const findings = await checkServiceConfig({
        PII_SERVICE_LEARNED_STORE: 'postgres',
        PII_SERVICE_DATABASE_URL: url,
      });
      expect(find(findings, 'database-tls')).toEqual([
        { severity: 'ok', check: 'database-tls', message: 'The database is on this machine; TLS is not required.' },
      ]);
    }
    const viaEnv = await checkServiceConfig({
      PII_SERVICE_LEARNED_STORE: 'postgres',
      PII_SERVICE_DATABASE_URL: 'postgres://app@db.internal/app',
      PGSSLMODE: 'verify-full',
    });
    expect(find(viaEnv, 'database-tls')[0]?.severity).toBe('ok');
  });

  it('checks the learned types file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pii-shield-doctor-'));
    try {
      const file = join(dir, 'learned-types.json');
      expect(find(await checkServiceConfig({ PII_SERVICE_LEARNED_TYPES: file }), 'learned-store')[0]?.message).toBe(
        'PII_SERVICE_LEARNED_TYPES does not exist yet; it is created with the first type.',
      );
      await writeFile(file, '[]');
      expect(find(await checkServiceConfig({ PII_SERVICE_LEARNED_TYPES: file }), 'learned-store')[0]?.severity).toBe(
        'ok',
      );
      expect(find(await checkServiceConfig({ PII_SERVICE_LEARNED_TYPES: dir }), 'learned-store')[0]?.severity).toBe(
        'error',
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('reports unreachable servers with --connect, without URLs or passwords', async () => {
    const findings = await checkServiceConfig(
      {
        PII_SERVICE_VAULT_STORE: 'postgres',
        PII_SERVICE_VAULT_KEY: KEY,
        PII_SERVICE_LEARNED_STORE: 'redis',
        // Port 1: refused at once.
        PII_SERVICE_DATABASE_URL: `postgres://app:${PASSWORD}@127.0.0.1:1/app`,
        PII_SERVICE_REDIS_URL: `redis://:${PASSWORD}@127.0.0.1:1`,
      },
      { connect: true },
    );

    expect(summary(findings.filter((f) => f.check.startsWith('connect')))).toEqual([
      'error connect-postgres',
      'error connect-redis',
    ]);
    expect(JSON.stringify(findings)).not.toMatch(new RegExp(`${PASSWORD}|postgres://|redis://`));
  });

  it('has nothing to connect to with memory stores', async () => {
    expect(find(await checkServiceConfig({}, { connect: true }), 'connect')).toEqual([
      { severity: 'info', check: 'connect', message: 'Nothing to connect to: no store uses Redis or PostgreSQL.' },
    ]);
  });
});

describe('pii-shield doctor', () => {
  const run = async (argv: string[], env: Record<string, string>) => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);

      return true;
    });
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = await main(argv, env);
    vi.restoreAllMocks();

    return { code, out };
  };

  it('prints findings and a summary, exit code 0 without errors', async () => {
    const { code, out } = await run(['doctor'], {});

    expect(code).toBe(0);
    expect(out).toMatch(/^warning token +PII_SERVICE_TOKEN is not set/m);
    expect(out).toMatch(/\n0 error\(s\), 1 warning\(s\), 5 note\(s\), 2 ok\n$/);
  });

  it('prints JSON with --json and exits with 1 on errors', async () => {
    const { code, out } = await run(['doctor', '--json', '--host', '0.0.0.0'], { PII_SERVICE_ONLY: '1' });
    const parsed = JSON.parse(out) as { ok: boolean; findings: ConfigFinding[] };

    expect(code).toBe(1);
    expect(parsed.ok).toBe(false);
    expect(parsed.findings).toContainEqual(expect.objectContaining({ severity: 'error', check: 'token' }));
    expect(parsed.findings).toContainEqual(expect.objectContaining({ severity: 'warning', check: 'listen' }));
  });

  it('rejects options of other commands', async () => {
    expect((await run(['doctor', '--port', '1'], {})).code).toBe(2);
    expect((await run(['serve', '--json'], {})).code).toBe(2);
  });
});

describe.skipIf(TEST_DATABASE_URL === '')('pii-shield doctor --connect on Postgres (PII_TEST_DATABASE_URL)', () => {
  let admin: pg.Pool;
  const schema = `pii_shield_doctor_${randomBytes(4).toString('hex')}`;
  const url = (searchPath: string) => {
    const u = new URL(TEST_DATABASE_URL);
    u.searchParams.set('options', `-c search_path=${searchPath}`);

    return u.toString();
  };
  const env = (searchPath: string) => ({
    PII_SERVICE_VAULT_STORE: 'postgres',
    PII_SERVICE_LEARNED_STORE: 'postgres',
    PII_SERVICE_LEARNED_KEEP_EXAMPLES: 'false',
    PII_SERVICE_VAULT_PURGE_INTERVAL: '0',
    PII_SERVICE_VAULT_KEY: KEY,
    PII_SERVICE_DATABASE_URL: url(searchPath),
  });

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"; CREATE SCHEMA "${schema}_empty"`);
    await admin.query(`SET search_path = "${schema}"; ${postgresSchema()}`);
    await admin.query(`INSERT INTO "${schema}".pii_shield_learned_types VALUES ('POLICY_NUMBER', $1)`, [
      JSON.stringify({
        name: 'POLICY_NUMBER',
        description: 'Polizzennummer',
        examples: ['POL-2026-004711'],
        counterExamples: [],
        pattern: 'POL-\\d{4}-\\d{6}',
      }),
    ]);
    await admin.query(`INSERT INTO "${schema}".pii_shield_vault VALUES ('x', '\\x00', now() - interval '1 second')`);
  });
  afterAll(async () => {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE; DROP SCHEMA "${schema}_empty" CASCADE`);
    await admin.end();
  });

  it('checks connection, tables, rights and stored data', async () => {
    const findings = await checkServiceConfig(env(schema), { connect: true });

    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(summary(findings.filter((f) => f.check.startsWith('connect')))).toEqual([
      'ok connect-postgres',
      'ok connect-vault-table',
      'ok connect-learned-table',
    ]);
    expect(find(findings, 'vault-purge').map((f) => f.message)).toContain(
      '1 expired vault row(s) are waiting to be deleted.',
    );
    expect(find(findings, 'learned-examples').map((f) => f.message)).toContain(
      '1 stored learned type(s) still hold examples; EntityLearner.dropExamples() removes them.',
    );
  });

  it('reports missing tables', async () => {
    const findings = await checkServiceConfig(env(`${schema}_empty`), { connect: true });

    expect(findings.filter((f) => f.severity === 'error')).toEqual([
      {
        severity: 'error',
        check: 'connect-vault-table',
        message:
          'The table pii_shield_vault cannot be read: relation "pii_shield_vault" does not exist. Create the tables with "pii-shield db-schema".',
      },
      {
        severity: 'error',
        check: 'connect-learned-table',
        message:
          'The table pii_shield_learned_types cannot be read: relation "pii_shield_learned_types" does not exist. Create the tables with "pii-shield db-schema".',
      },
    ]);
  });
});
