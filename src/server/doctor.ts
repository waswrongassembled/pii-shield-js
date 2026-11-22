/**
 * `pii-shield doctor`: checks the service configuration from the environment with the rules of
 * serviceFromEnv() (src/server/env.ts) plus security recommendations. Findings name variables, never
 * their values: no token, key, URL, password or provider key appears in a message.
 */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type CustomEntityStore, KeyValueCustomEntityStore } from '../learning/store.js';
import { ModelLocation } from '../model/model-detector.js';
import { splitList } from '../service/local-peer.js';
import { connections } from './connections.js';
import {
  assertVaultKeyFor,
  ConfigError,
  type Env,
  envGetter,
  type LearnedStoreKind,
  type ModelConfig,
  readDatabaseUrl,
  readKeepExamples,
  readLearnedStore,
  readListen,
  readModel,
  readPreviousVaultKeys,
  readPurgeInterval,
  readRedisUrl,
  readVaultKey,
  readVaultStore,
  readVaultTtl,
  type VaultStoreKind,
} from './env.js';

/** `error`: the service would not start or not work; `warning`: it works, but should be changed. */
export type FindingSeverity = 'error' | 'warning' | 'info' | 'ok';

export interface ConfigFinding {
  readonly severity: FindingSeverity;
  /** What was checked, a stable id such as `vault-key`, `token` or `database-tls`. */
  readonly check: string;
  /** For the operator; names variables, never their values. */
  readonly message: string;
}

export interface CheckServiceConfigOptions {
  /**
   * Also connect to Redis and PostgreSQL (when configured): checks that they answer, that the tables
   * exist and are readable, and the database role's rights. Reads only, never writes. Default false.
   */
  connect?: boolean;
  /** The listen address if it is given on the command line (`--host`), else PII_SERVICE_HOST. */
  host?: string | undefined;
}

/** The longest vault TTL without a warning: one hour. */
const MAX_RECOMMENDED_TTL = 3600;
const MIN_TOKEN_LENGTH = 32;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Checks the service configuration in `env` (the variables of docs/server.md) and returns findings,
 * errors first in each area. Nothing is printed; secrets are never part of a finding. Without
 * `connect` it is static (it only looks at files for the learned types).
 */
export async function checkServiceConfig(
  env: Env = process.env,
  options: CheckServiceConfigOptions = {},
): Promise<ConfigFinding[]> {
  const get = envGetter(env);
  const findings: ConfigFinding[] = [];
  const add = (severity: FindingSeverity, check: string, message: string): void => {
    findings.push(Object.freeze({ severity, check, message }));
  };
  /** Runs one of serviceFromEnv()'s readers; its ConfigError becomes an error finding. */
  const read = <T>(check: string, reader: () => T): T | undefined => {
    try {
      return reader();
    } catch (e) {
      if (e instanceof ConfigError) {
        add('error', check, e.message);

        return undefined;
      }
      throw e;
    }
  };

  // Vault
  const vaultStore = read('vault-store', () => readVaultStore(get));
  const key = read('vault-key', () => readVaultKey(get));
  const previousKeys = read('vault-previous-keys', () => readPreviousVaultKeys(get, env)) ?? [];
  try {
    if (key !== undefined) {
      add('ok', 'vault-key', 'PII_SERVICE_VAULT_KEY is set and valid.');
    } else if (get('PII_SERVICE_VAULT_KEY') === undefined && vaultStore === 'memory') {
      add(
        'info',
        'vault-key',
        'PII_SERVICE_VAULT_KEY is not set: a random key per process (fine for the memory vault).',
      );
    } else if (get('PII_SERVICE_VAULT_KEY') === undefined && vaultStore !== undefined) {
      read('vault-key', () => {
        assertVaultKeyFor(vaultStore, false);
      });
    }
    if (previousKeys.length > 0) {
      if (key !== undefined && previousKeys.some((previous) => Buffer.from(previous).equals(Buffer.from(key)))) {
        add('warning', 'vault-previous-keys', 'PII_SERVICE_VAULT_PREVIOUS_KEYS contains the current key.');
      } else {
        add(
          'info',
          'vault-previous-keys',
          `PII_SERVICE_VAULT_PREVIOUS_KEYS: ${String(previousKeys.length)} valid key(s). Remove them once the longest vault TTL since the rotation has passed.`,
        );
      }
    }
  } finally {
    key?.fill(0);
    for (const previous of previousKeys) {
      previous.fill(0);
    }
  }
  if (vaultStore === 'memory') {
    add('info', 'vault-store', 'Vault in memory: mappings are lost on restart and not shared between instances.');
  } else if (vaultStore !== undefined) {
    add('ok', 'vault-store', `Vault in ${vaultStore}.`);
  }
  const ttl = read('vault-ttl', () => readVaultTtl(get));
  if (ttl !== undefined) {
    if (ttl > MAX_RECOMMENDED_TTL) {
      add(
        'warning',
        'vault-ttl',
        'PII_SERVICE_VAULT_TTL is above one hour: keep mappings only as long as a request needs them (storage limitation, Art. 5(1)(e) GDPR).',
      );
    } else {
      add('ok', 'vault-ttl', `Vault TTL ${String(ttl)} s.`);
    }
  }
  const purgeInterval = vaultStore === 'postgres' ? read('vault-purge', () => readPurgeInterval(get)) : undefined;
  if (purgeInterval === 0) {
    add(
      'warning',
      'vault-purge',
      'PII_SERVICE_VAULT_PURGE_INTERVAL=0: expired vault rows are not deleted by the service; make sure a job (e.g. pg_cron) deletes them.',
    );
  } else if (purgeInterval !== undefined) {
    add('ok', 'vault-purge', `Expired vault rows are deleted every ${String(purgeInterval)} s.`);
  }

  // Access
  const token = get('PII_SERVICE_TOKEN');
  const serviceOnly = get('PII_SERVICE_ONLY') === '1';
  if (token === undefined) {
    if (serviceOnly) {
      add('error', 'token', 'PII_SERVICE_ONLY=1 without PII_SERVICE_TOKEN: every request is answered with 503.');
    } else {
      add(
        'warning',
        'token',
        'PII_SERVICE_TOKEN is not set: only local peers are answered (127.0.0.1, ::1, PII_LOCAL_PEERS). Set a token for anything reachable from the network.',
      );
    }
  } else if (token.length < MIN_TOKEN_LENGTH) {
    add(
      'warning',
      'token',
      `PII_SERVICE_TOKEN is shorter than ${String(MIN_TOKEN_LENGTH)} characters: use a long random token (openssl rand -hex 24).`,
    );
  } else {
    add('ok', 'token', 'PII_SERVICE_TOKEN is set.');
  }
  const listen = read('listen', () => readListen(get));
  if (listen !== undefined) {
    const host = options.host ?? listen.host;
    const loopback = isLoopback(host);
    if (loopback) {
      add('ok', 'listen', 'The service listens on a loopback address.');
    } else if (token === undefined) {
      add(
        'warning',
        'listen',
        `The service listens on ${host === '0.0.0.0' || host === '::' || host === '[::]' ? 'all interfaces' : 'a non-loopback address'} without PII_SERVICE_TOKEN: set a token (and PII_SERVICE_ONLY=1).`,
      );
    } else {
      add(
        'info',
        'listen',
        'The service listens on a non-loopback address and speaks plain HTTP: put a reverse proxy with TLS in front, set PII_SERVICE_ONLY=1 and PII_SERVICE_ALLOWED_HOSTS.',
      );
    }
  }
  if (token === undefined && splitList(get('PII_LOCAL_PEERS')).length > 0) {
    add('info', 'local-peers', 'PII_LOCAL_PEERS: these addresses are answered without a token.');
  }

  // Learned types
  const learned = read('learned-store', () => readLearnedStore(get));
  if (learned?.kind === 'memory') {
    add('info', 'learned-store', 'Learned types in memory: they are lost on restart.');
  } else if (learned?.kind === 'file') {
    add(...(await checkLearnedFile(learned.file ?? '')));
  } else if (learned !== undefined) {
    add('ok', 'learned-store', `Learned types in ${learned.kind}.`);
  }
  const keepExamples = read('learned-examples', () => readKeepExamples(get));
  if (keepExamples === true) {
    add(
      learned === undefined || learned.kind === 'memory' ? 'info' : 'warning',
      'learned-examples',
      'Learned types keep their examples and counter-examples in plain text (may be personal data). PII_SERVICE_LEARNED_KEEP_EXAMPLES=false stores name, description and pattern only (model-only types are then refused).',
    );
  } else if (keepExamples === false) {
    add(
      'ok',
      'learned-examples',
      'Learned types are stored without examples; model-only types (no pattern) are refused.',
    );
  }

  // Connections
  const usesPostgres = vaultStore === 'postgres' || learned?.kind === 'postgres';
  const usesRedis = vaultStore === 'redis' || learned?.kind === 'redis';
  let databaseUrl: string | undefined;
  if (usesPostgres) {
    databaseUrl = read('database-url', () => readDatabaseUrl(get));
    if (databaseUrl !== undefined) {
      add(...databaseTls(new URL(databaseUrl), get('PGSSLMODE')));
    }
  } else if (get('PII_SERVICE_DATABASE_URL') !== undefined) {
    add('info', 'database-url', 'PII_SERVICE_DATABASE_URL is set, but no store uses postgres.');
  }
  let redisUrl: string | undefined;
  if (usesRedis) {
    redisUrl = read('redis-url', () => readRedisUrl(get));
    if (redisUrl !== undefined) {
      add(...redisTls(redisUrl));
    }
  }

  // Model
  const model = read('model', () => readModel(get));
  if (model === undefined) {
    if (get('PII_SERVICE_MODEL_PROVIDER') === undefined) {
      add('info', 'model', 'No model provider: detection uses patterns and checksums only.');
    }
  } else {
    add(...modelFinding(model, get('PII_SERVICE_MODEL_URL') ?? get('PII_DEMO_OLLAMA_URL')));
  }

  if (options.connect === true) {
    const reachable = {
      postgres: usesPostgres && databaseUrl !== undefined,
      redis: usesRedis && redisUrl !== undefined,
    };
    if (reachable.postgres || reachable.redis) {
      findings.push(
        ...(await connectChecks(get, {
          ...reachable,
          vaultStore,
          learnedStore: learned?.kind,
          keepExamples,
          purgeInterval,
          localDatabase: databaseUrl !== undefined && isLocalDatabase(new URL(databaseUrl)),
        })),
      );
    } else {
      add('info', 'connect', 'Nothing to connect to: no store uses Redis or PostgreSQL.');
    }
  }

  return findings;
}

type Finding = [FindingSeverity, string, string];

async function checkLearnedFile(file: string): Promise<Finding> {
  try {
    if ((await stat(file)).isDirectory()) {
      return ['error', 'learned-store', 'PII_SERVICE_LEARNED_TYPES is a directory, not a file.'];
    }
    await access(file, constants.R_OK | constants.W_OK);

    return ['ok', 'learned-store', 'Learned types in a JSON file (PII_SERVICE_LEARNED_TYPES), readable and writable.'];
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'ENOENT') {
      return ['error', 'learned-store', 'PII_SERVICE_LEARNED_TYPES cannot be read and written by this user.'];
    }
  }
  try {
    await access(dirname(file), constants.W_OK);

    return ['ok', 'learned-store', 'PII_SERVICE_LEARNED_TYPES does not exist yet; it is created with the first type.'];
  } catch {
    return [
      'error',
      'learned-store',
      'PII_SERVICE_LEARNED_TYPES does not exist and its directory is missing or not writable.',
    ];
  }
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

function isLocalDatabase(url: URL): boolean {
  const socket = url.searchParams.get('host');

  return socket?.startsWith('/') === true || url.hostname === '' || isLoopback(url.hostname);
}

/** sslmode of the URL (or PGSSLMODE); a remote database needs TLS that verifies the server. */
function databaseTls(url: URL, envSslMode: string | undefined): Finding {
  if (isLocalDatabase(url)) {
    return ['ok', 'database-tls', 'The database is on this machine; TLS is not required.'];
  }
  const sslMode = url.searchParams.get('sslmode') ?? envSslMode;
  const ssl = url.searchParams.get('ssl');
  if (sslMode === 'verify-full') {
    return ['ok', 'database-tls', 'The database connection uses TLS with sslmode=verify-full.'];
  }
  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'no-verify') {
    return [
      'warning',
      'database-tls',
      `sslmode=${sslMode} in PII_SERVICE_DATABASE_URL does not check the server's name (libpq semantics): use sslmode=verify-full.`,
    ];
  }
  if (sslMode === undefined && (ssl === 'true' || ssl === '1')) {
    return [
      'warning',
      'database-tls',
      'PII_SERVICE_DATABASE_URL enables TLS with ssl=true: prefer sslmode=verify-full.',
    ];
  }

  return [
    'error',
    'database-tls',
    `The database is not on this machine and PII_SERVICE_DATABASE_URL ${sslMode === undefined ? 'has no sslmode' : `has sslmode=${['disable', 'allow', 'prefer'].includes(sslMode) ? sslMode : 'of an unknown value'}`}: TLS is not enforced. Add sslmode=verify-full (at least require).`,
  ];
}

function redisTls(url: string): Finding {
  if (!URL.canParse(url)) {
    return ['warning', 'redis-tls', 'PII_SERVICE_REDIS_URL is not a URL (redis:// or rediss://).'];
  }
  const parsed = new URL(url);
  if (parsed.protocol === 'rediss:') {
    return ['ok', 'redis-tls', 'Redis is reached over TLS (rediss://).'];
  }
  if (isLoopback(parsed.hostname)) {
    return ['ok', 'redis-tls', 'Redis is on this machine; TLS is not required.'];
  }

  return [
    'warning',
    'redis-tls',
    'Redis is not on this machine and is reached without TLS: use a rediss:// URL (learned types are stored in plain text).',
  ];
}

function modelFinding(model: ModelConfig, endpoint: string | undefined): Finding {
  if (model.location === ModelLocation.External) {
    return [
      'warning',
      'model',
      `${model.provider} is an external provider and PII_SERVICE_ACKNOWLEDGE_EXTERNAL=true: detection sends the unredacted text there. Make sure of a legal basis (Art. 6 GDPR), a data processing agreement (Art. 28) and, outside the EU/EEA, a transfer mechanism (Art. 44 ff.).`,
    ];
  }
  if (model.location === ModelLocation.OnPremise && endpoint?.trim().toLowerCase().startsWith('http://') === true) {
    return [
      'warning',
      'model',
      'The model server (PII_SERVICE_MODEL_URL) is reached over plain HTTP: the unredacted text crosses the network unencrypted. Use https://.',
    ];
  }

  return ['ok', 'model', `Model provider ${model.provider} (${model.location}).`];
}

interface ConnectPlan {
  postgres: boolean;
  redis: boolean;
  vaultStore: VaultStoreKind | undefined;
  learnedStore: LearnedStoreKind | undefined;
  keepExamples: boolean | undefined;
  purgeInterval: number | undefined;
  localDatabase: boolean;
}

/** The tables the service uses (it always uses the default names). */
const VAULT_TABLE = 'pii_shield_vault';
const TYPES_TABLE = 'pii_shield_learned_types';

async function connectChecks(get: (name: string) => string | undefined, plan: ConnectPlan): Promise<ConfigFinding[]> {
  const findings: ConfigFinding[] = [];
  const add = (severity: FindingSeverity, check: string, message: string): void => {
    findings.push(Object.freeze({ severity, check, message }));
  };
  const connection = connections(get, { failFast: true, onPoolError: () => undefined });
  try {
    if (plan.postgres) {
      await checkPostgres(connection, plan, add);
    }
    if (plan.redis) {
      await checkRedis(connection, plan, add);
    }
  } finally {
    await connection.closeQuietly();
  }

  return findings;
}

type Add = (severity: FindingSeverity, check: string, message: string) => void;

async function checkPostgres(connection: ReturnType<typeof connections>, plan: ConnectPlan, add: Add): Promise<void> {
  let query;
  try {
    query = await connection.postgres();
    const { rows } = await query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()', []);
    add('ok', 'connect-postgres', 'PostgreSQL answers.');
    const ssl = (rows[0] as { ssl?: unknown } | undefined)?.ssl === true;
    if (ssl) {
      add('ok', 'connect-postgres-tls', 'The database connection is encrypted (TLS).');
    } else if (!plan.localDatabase) {
      add('error', 'connect-postgres-tls', 'The connection to the database is not encrypted.');
    }
  } catch (e) {
    add('error', 'connect-postgres', `PostgreSQL cannot be reached: ${connection.safeMessage(e)}`);

    return;
  }
  const { PostgresCustomEntityStore, PostgresVaultStorage } = await import('../postgres/index.js');
  const rights = async (table: string): Promise<string[]> => {
    const { rows } = await query(
      "SELECT has_table_privilege($1, 'SELECT') AS s, has_table_privilege($1, 'INSERT') AS i, has_table_privilege($1, 'UPDATE') AS u, has_table_privilege($1, 'DELETE') AS d",
      [table],
    );
    const row = (rows[0] ?? {}) as Record<string, unknown>;

    return (
      [
        ['s', 'SELECT'],
        ['i', 'INSERT'],
        ['u', 'UPDATE'],
        ['d', 'DELETE'],
      ] as const
    )
      .filter(([column]) => row[column] !== true)
      .map(([, right]) => right);
  };
  const tables: [string, string, () => Promise<void>][] = [];
  if (plan.vaultStore === 'postgres') {
    tables.push([
      'connect-vault-table',
      VAULT_TABLE,
      async () => {
        await new PostgresVaultStorage({ query }).get('pii-shield-doctor-check');
        if (plan.purgeInterval === 0) {
          const { rows } = await query(`SELECT count(*) AS n FROM "${VAULT_TABLE}" WHERE expires_at <= now()`, []);
          const expired = Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
          if (expired > 0) {
            add('warning', 'vault-purge', `${String(expired)} expired vault row(s) are waiting to be deleted.`);
          }
        }
      },
    ]);
  }
  if (plan.learnedStore === 'postgres') {
    tables.push([
      'connect-learned-table',
      TYPES_TABLE,
      async () => {
        await learnedTypesFinding(new PostgresCustomEntityStore({ query }), plan, add);
      },
    ]);
  }
  for (const [check, table, readTable] of tables) {
    try {
      await readTable();
    } catch (e) {
      add(
        'error',
        check,
        `The table ${table} cannot be read: ${connection.safeMessage(e)}. Create the tables with "pii-shield db-schema".`,
      );
      continue;
    }
    try {
      const missing = await rights(table);
      if (missing.length === 0) {
        add('ok', check, `The table ${table} exists; the role may read and write it.`);
      } else {
        add('error', check, `The database role lacks ${missing.join(', ')} on ${table}.`);
      }
    } catch (e) {
      add('warning', check, `The rights on ${table} cannot be checked: ${connection.safeMessage(e)}`);
    }
  }
}

async function checkRedis(connection: ReturnType<typeof connections>, plan: ConnectPlan, add: Add): Promise<void> {
  let client;
  try {
    client = await connection.redis();
    await client.ping();
    add('ok', 'connect-redis', 'Redis answers.');
  } catch (e) {
    add('error', 'connect-redis', `Redis cannot be reached: ${connection.safeMessage(e)}`);

    return;
  }
  if (plan.learnedStore === 'redis') {
    try {
      await learnedTypesFinding(new KeyValueCustomEntityStore(client), plan, add);
    } catch (e) {
      add('error', 'connect-learned-redis', `The learned types cannot be read: ${connection.safeMessage(e)}`);
    }
  }
}

async function learnedTypesFinding(store: CustomEntityStore, plan: ConnectPlan, add: Add): Promise<void> {
  const types = await store.all();
  if (plan.keepExamples === false) {
    const withExamples = types.filter((t) => t.pattern !== null && t.examples.length > 0).length;
    if (withExamples > 0) {
      add(
        'warning',
        'learned-examples',
        `${String(withExamples)} stored learned type(s) still hold examples; EntityLearner.dropExamples() removes them.`,
      );
    }
  }
  add('info', 'learned-types', `${String(types.length)} learned type(s) stored.`);
}

/** The findings as text, one line each, and a summary. */
export function formatFindings(findings: readonly ConfigFinding[]): string {
  const counts = countFindings(findings);
  const lines = findings.map((f) => `${f.severity.padEnd(8)}${f.check.padEnd(24)}${f.message}`);
  lines.push(
    '',
    `${String(counts.error)} error(s), ${String(counts.warning)} warning(s), ${String(counts.info)} note(s), ${String(counts.ok)} ok`,
  );

  return `${lines.join('\n')}\n`;
}

export function countFindings(findings: readonly ConfigFinding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0, ok: 0 };
  for (const { severity } of findings) {
    counts[severity]++;
  }

  return counts;
}
