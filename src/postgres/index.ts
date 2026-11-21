/**
 * @waswrongassembled/pii-shield/postgres: VaultStorage and CustomEntityStore on PostgreSQL. No driver
 * dependency: both take a `query(text, params)` function, so a `pg` Pool, a `PoolClient` inside the
 * product's transaction or a wrapper around another driver all work.
 */
import { createHash } from 'node:crypto';

import { PiiShieldError, VaultError } from '../errors.js';
import { type CustomEntityType, customEntityTypeFromJSON } from '../learning/custom-entity-type.js';
import { type CustomEntityStore, sortByName } from '../learning/store.js';
import { assertTtl, type VaultStorage } from '../vault/vault.js';

/** What a query function resolves to: the result rows as objects keyed by column name. */
export interface PostgresQueryResult {
  rows: readonly unknown[];
}

/**
 * Runs one parameterised statement (`$1`, `$2`, ...) and resolves with its rows. The shape of `pg`'s
 * `query()`: pass `pool.query.bind(pool)`, `client.query.bind(client)` or `(text, params) => pool.query(text, params)`.
 * For another driver, wrap it, e.g. postgres.js: `(text, params) => sql.unsafe(text, params).then((rows) => ({ rows }))`.
 *
 * The stores never open or end transactions: every call is one statement, so they take part in
 * whatever transaction the connection behind the function is in.
 */
export type PostgresQuery = (text: string, params: unknown[]) => Promise<PostgresQueryResult>;

/** Default table of PostgresVaultStorage. */
export const DEFAULT_VAULT_TABLE = 'pii_shield_vault';
/** Default table of PostgresCustomEntityStore. */
export const DEFAULT_TYPES_TABLE = 'pii_shield_learned_types';

export interface PostgresStoreOptions {
  query: PostgresQuery;
  /**
   * Table name, optionally schema-qualified (`app.pii_vault`). Each part must be a plain identifier
   * (`[A-Za-z_][A-Za-z0-9_]*`, at most 48 characters); it is always double-quoted, so the case is kept.
   */
  table?: string;
}

/**
 * Stores vault ciphertext in a table (`id text primary key, payload bytea, expires_at timestamptz`, see
 * postgresSchema()). Use it behind EncryptedVault, never on its own: the database then only sees
 * ciphertext and the key stays outside it.
 *
 * - The row id is `sha256hex(id)`, like RedisVaultStorage: ids may come from outside.
 * - Expiry uses the database clock (`now()`, the start of the current transaction), not the app clock:
 *   several app servers with skewed clocks agree. Reads ignore expired rows; purgeExpired() deletes them,
 *   which must happen regularly (storage limitation, Art. 5(1)(e) GDPR).
 */
export class PostgresVaultStorage implements VaultStorage {
  readonly #query: PostgresQuery;
  readonly #sql: { put: string; get: string; remove: string; purge: string };

  constructor(options: PostgresStoreOptions) {
    this.#query = options.query;
    const table = quoteTable(options.table ?? DEFAULT_VAULT_TABLE);
    this.#sql = {
      put:
        `INSERT INTO ${table} (id, payload, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3)) ` +
        'ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at',
      get: `SELECT payload FROM ${table} WHERE id = $1 AND expires_at > now()`,
      remove: `DELETE FROM ${table} WHERE id = $1`,
      // SKIP LOCKED: purges running at the same time (several servers) neither wait for nor deadlock
      // each other, and rows being rewritten by put() are left alone. The count comes back as a row,
      // so the query function needs no rowCount.
      purge:
        `WITH expired AS (SELECT id FROM ${table} WHERE expires_at <= now() FOR UPDATE SKIP LOCKED), ` +
        `deleted AS (DELETE FROM ${table} AS t USING expired WHERE t.id = expired.id RETURNING 1) ` +
        'SELECT count(*) AS deleted FROM deleted',
    };
  }

  async put(id: string, payload: Uint8Array, ttlSeconds: number): Promise<void> {
    assertTtl(ttlSeconds);
    // A Buffer over exactly the view's bytes: drivers send a Buffer as binary.
    await this.#query(this.#sql.put, [
      vaultKey(id),
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
      ttlSeconds,
    ]);
  }

  async get(id: string): Promise<Uint8Array | null> {
    const { rows } = await this.#query(this.#sql.get, [vaultKey(id)]);
    const payload = column(rows[0], 'payload');
    if (payload === undefined) {
      return null;
    }
    if (!(payload instanceof Uint8Array)) {
      throw new VaultError('The vault table returned a payload that is not binary (bytea).', 'VAULT_CORRUPT');
    }

    return new Uint8Array(payload);
  }

  async remove(id: string): Promise<void> {
    await this.#query(this.#sql.remove, [vaultKey(id)]);
  }

  /**
   * Deletes expired rows (by the database clock). Run it regularly, e.g. from a timer, a cron job or
   * `pg_cron`; the HTTP service does it every `PII_SERVICE_VAULT_PURGE_INTERVAL` seconds.
   *
   * @returns the number of deleted rows
   */
  async purgeExpired(): Promise<number> {
    const { rows } = await this.#query(this.#sql.purge, []);
    const deleted = Number(column(rows[0], 'deleted') ?? 0);

    return Number.isFinite(deleted) ? deleted : 0;
  }
}

/**
 * Learned entity types in a table, one row per type (`name text primary key, data jsonb`, see
 * postgresSchema()). save() is one upsert and remove() one delete, so concurrent writes of different
 * names from any number of processes never lose each other.
 *
 * `data` is the type's JSON (the shape of JsonFileCustomEntityStore's entries); rows are validated with
 * customEntityTypeFromJSON() when read. Examples are plain text and may be personal data: grant access
 * to the table like to other personal data, and remember that a deleted row stays in WAL, backups and,
 * until VACUUM, in the table file.
 */
export class PostgresCustomEntityStore implements CustomEntityStore {
  readonly #query: PostgresQuery;
  readonly #sql: { all: string; get: string; save: string; remove: string };

  constructor(options: PostgresStoreOptions) {
    this.#query = options.query;
    const table = quoteTable(options.table ?? DEFAULT_TYPES_TABLE);
    this.#sql = {
      all: `SELECT name, data FROM ${table}`,
      get: `SELECT name, data FROM ${table} WHERE name = $1`,
      save: `INSERT INTO ${table} (name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
      remove: `DELETE FROM ${table} WHERE name = $1`,
    };
  }

  async all(): Promise<CustomEntityType[]> {
    const { rows } = await this.#query(this.#sql.all, []);

    // Sorted here, not with ORDER BY: byte order like the other stores, whatever the column's collation.
    return sortByName(rows.map((row) => typeFromRow(row)));
  }

  async get(name: string): Promise<CustomEntityType | null> {
    const { rows } = await this.#query(this.#sql.get, [name]);

    return rows.length === 0 ? null : typeFromRow(rows[0]);
  }

  async save(type: CustomEntityType): Promise<void> {
    await this.#query(this.#sql.save, [type.name, JSON.stringify(type)]);
  }

  async remove(name: string): Promise<void> {
    await this.#query(this.#sql.remove, [name]);
  }
}

export interface PostgresSchemaOptions {
  /** Vault table (default `pii_shield_vault`); `null` leaves it out. */
  vaultTable?: string | null;
  /** Learned types table (default `pii_shield_learned_types`); `null` leaves it out. */
  typesTable?: string | null;
}

/**
 * The DDL for both tables, idempotent (`CREATE … IF NOT EXISTS`), for the product's own migrations or
 * `psql`. The library never runs DDL itself. A schema in a qualified name must exist already.
 *
 * The application's database role needs only `SELECT, INSERT, UPDATE, DELETE` on the two tables.
 */
export function postgresSchema(options: PostgresSchemaOptions = {}): string {
  const statements: string[] = [];
  const { vaultTable = DEFAULT_VAULT_TABLE, typesTable = DEFAULT_TYPES_TABLE } = options;
  if (vaultTable !== null) {
    const table = quoteTable(vaultTable);
    const index = quoteIdentifier(`${tableName(vaultTable)}_expires_at_idx`);
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${table} (\n    id text PRIMARY KEY,\n    payload bytea NOT NULL,\n    expires_at timestamptz NOT NULL\n);`,
      `CREATE INDEX IF NOT EXISTS ${index} ON ${table} (expires_at);`,
      `COMMENT ON TABLE ${table} IS 'pii-shield vault: encrypted placeholder mappings (ciphertext only). Delete expired rows regularly (purgeExpired()).';`,
    );
  }
  if (typesTable !== null) {
    const table = quoteTable(typesTable);
    statements.push(
      `CREATE TABLE IF NOT EXISTS ${table} (\n    name text PRIMARY KEY,\n    data jsonb NOT NULL\n);`,
      `COMMENT ON TABLE ${table} IS 'pii-shield learned entity types. Examples are plain text and may be personal data.';`,
    );
  }

  return `${statements.join('\n')}\n`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

/**
 * `"table"` or `"schema"."table"`, after checking each part against IDENTIFIER. The pattern has no
 * quote, so quoting cannot be escaped; the name is never part of an error message beyond that check.
 */
function quoteTable(name: string): string {
  if (typeof name !== 'string') {
    throw new TypeError('The table name must be a string.');
  }
  const parts = name.split('.');
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new RangeError(
      'The table name must be an identifier ([A-Za-z_][A-Za-z0-9_]*, at most 48 characters), optionally schema-qualified (schema.table).',
    );
  }

  return parts.map(quoteIdentifier).join('.');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier}"`;
}

/** The table part of a (validated) qualified name. */
function tableName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf('.') + 1);
}

function vaultKey(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function column(row: unknown, name: string): unknown {
  return typeof row === 'object' && row !== null && Object.hasOwn(row, name)
    ? (row as Record<string, unknown>)[name]
    : undefined;
}

function typeFromRow(row: unknown): CustomEntityType {
  let data = column(row, 'data');
  if (typeof data === 'string') {
    // Drivers that do not parse jsonb return text. No cause: V8's JSON.parse() message quotes the text.
    try {
      data = JSON.parse(data);
    } catch {
      data = undefined;
    }
  }
  if (typeof data !== 'object' || data === null) {
    throw corrupt();
  }
  const type = customEntityTypeFromJSON(data);
  if (type.name !== column(row, 'name')) {
    throw corrupt();
  }

  return type;
}

function corrupt(): PiiShieldError {
  return new PiiShieldError(
    'The learned types table contains a row that is not a learned type.',
    'LEARNING_STORE_CORRUPT',
  );
}
