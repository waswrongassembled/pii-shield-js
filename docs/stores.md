# Stores: vault storage and learned types

pii-shield keeps two kinds of state between requests:

- **Vault entries:** the placeholder mapping of a redaction, encrypted by `EncryptedVault` and handed to a `VaultStorage` as ciphertext with a TTL.
- **Learned entity types:** names, descriptions, examples and patterns, kept by a `CustomEntityStore`.

| Backend    | VaultStorage                            | CustomEntityStore                               | Shared between processes                         |
| ---------- | --------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| Memory     | `MemoryVaultStorage`                    | `InMemoryCustomEntityStore`                     | no                                               |
| JSON file  | -                                       | `JsonFileCustomEntityStore` (PHP's file format) | yes, writes locked with a lock file              |
| Key-value  | -                                       | `KeyValueCustomEntityStore` (one JSON list)     | reads yes; concurrent writes can be lost (below) |
| Redis      | `RedisVaultStorage` (`.../vault-redis`) | `KeyValueCustomEntityStore` over ioredis        | yes                                              |
| PostgreSQL | `PostgresVaultStorage` (`.../postgres`) | `PostgresCustomEntityStore` (`.../postgres`)    | yes, one row per entry or type                   |

All examples use synthetic data.

## Contracts

Every backend keeps these rules. They are written down in the TSDoc of the interfaces and checked by the conformance suites below.

`VaultStorage`:

- `get()` of an unknown or expired id gives `null`. Expiry is checked on read, not left to a cleanup job. Expired entries must still really be deleted eventually.
- `put()` overwrites payload and expiry. `remove()` of an unknown id is a no-op.
- Payloads are binary-safe (every byte value, any length) and copied in and out.
- Ids may come from outside (a client's `vaultId`): map them to keys safely, e.g. by hashing. Never build a path or a query from an id.
- A TTL that is not a positive integer rejects the Promise before anything is stored.

`CustomEntityStore`:

- `all()` is sorted by name in byte order, whatever a database collation says.
- `get()` of an unknown name gives `null`. `save()` replaces a type with the same name. `remove()` of an unknown name is a no-op.
- Types read back are validated (`customEntityTypeFromJSON()`) and equal to what was saved.
- Concurrent `save()`/`remove()` calls for different names must not lose each other's writes. `KeyValueCustomEntityStore` keeps this only within one instance: it reads, changes and writes the whole list, so writers in several processes can overwrite each other. Serialise them yourself, or use `PostgresCustomEntityStore`, which writes one row per type.

## Write your own adapter

Implement the interface and run the conformance suite from `@waswrongassembled/pii-shield/testing` in your tests. It uses only `node:assert`, so it works under vitest, jest, mocha or `node:test`. It throws an `AssertionError` that names the broken rule (the original error is its `cause`), and returns which rules passed and which were skipped:

```ts
import { verifyCustomEntityStore, verifyVaultStorage } from '@waswrongassembled/pii-shield/testing';
import { InMemoryCustomEntityStore, MemoryVaultStorage } from '@waswrongassembled/pii-shield';

// Your storage instead of MemoryVaultStorage. `factory` is called once per rule.
let now = Date.now();
const report = await verifyVaultStorage(() => new MemoryVaultStorage({ clock: () => now }), {
  // Expire an entry as if its TTL had passed: here by advancing the injected clock.
  expire: () => {
    now += 61_000;
  },
});
console.log(report.skipped); // rules that needed an option you did not give

// The factory must return an empty store (truncate your table first).
await verifyCustomEntityStore(() => new InMemoryCustomEntityStore());
```

Options:

- **`expire(storage, id)`** makes one entry expired. A backend with its own clock cannot be given a fake one. For a database, set its expiry into the past, e.g. `UPDATE … SET expires_at = now() - interval '1 second' WHERE id = …`.
- **`realTimeExpiry: true`** is the slow alternative without a hook: a real TTL of 1 s and a wait of 1.5 s. Without either option the two expiry rules are skipped.
- **`secondInstance(store)`** returns another instance over the same backend. The vault suite then checks that entries are visible through it. The learned types suite checks that concurrent writes through both instances are all kept.

The suites write ids and names of their own. Vault ids are random per run, so a shared backend needs no cleanup between rules.

## PostgreSQL

`@waswrongassembled/pii-shield/postgres` has no driver dependency. Both stores take a `query(text, params)` function that resolves with `{ rows }`. That is the shape of `pg`'s `query()`, so you can pass any of these:

- a `Pool`: `pool.query.bind(pool)`;
- a `PoolClient` inside your transaction: `client.query.bind(client)`;
- a wrapper around another driver, e.g. for postgres.js: `(text, params) => sql.unsafe(text, params).then((rows) => ({ rows }))`.

Values always go in as parameters. Table names are configurable and validated: a plain identifier (`[A-Za-z_][A-Za-z0-9_]*`, at most 48 characters), optionally schema-qualified (`app.pii_vault`). They are always double-quoted, so their case is kept.

```ts
import pg from 'pg';
import { EncryptedVault, EntityLearner, parseVaultKey, PiiShield } from '@waswrongassembled/pii-shield';
import { PostgresCustomEntityStore, PostgresVaultStorage } from '@waswrongassembled/pii-shield/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const query = pool.query.bind(pool);

const storage = new PostgresVaultStorage({ query }); // table pii_shield_vault
const shield = new PiiShield({
  vault: new EncryptedVault({ storage, key: parseVaultKey(process.env.VAULT_KEY ?? '') }),
  vaultTtl: 900,
});
const learner = await EntityLearner.create({
  store: new PostgresCustomEntityStore({ query, table: 'app.learned_types' }),
});

// Expired rows must really be deleted: purge regularly (or from a cron job / pg_cron).
setInterval(() => void storage.purgeExpired().catch(() => undefined), 300_000).unref();
```

### Inside the product's transaction

The stores never send `BEGIN` or `COMMIT`. Each method is one statement on the function you pass. With a `PoolClient` they take part in your transaction, and a rollback removes the vault entry or learned type as well:

```ts
import pg from 'pg';
import { EncryptedVault, parseVaultKey, PiiShield } from '@waswrongassembled/pii-shield';
import { PostgresVaultStorage } from '@waswrongassembled/pii-shield/postgres';

declare const pool: pg.Pool;

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const shield = new PiiShield({
    vault: new EncryptedVault({
      storage: new PostgresVaultStorage({ query: client.query.bind(client) }),
      key: parseVaultKey(process.env.VAULT_KEY ?? ''),
    }),
  });
  const { redactedText, vaultId } = await shield.redactToVault('Herrn\nJohann Beispielmann\nSVNR 4568 150392');
  await client.query('INSERT INTO letters (vault_id, body) VALUES ($1, $2)', [vaultId, redactedText]);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
```

Expiry uses the database clock: `now()` is the start of the current transaction, so all app servers agree, whatever their clocks say. A vault entry written in a transaction that stays open for a long time expires relative to the transaction's start.

### Schema and migrations

The library never runs DDL. `postgresSchema()` returns idempotent SQL for your own migrations: `CREATE TABLE IF NOT EXISTS`, an index on `expires_at` and a comment per table. The CLI prints the default schema:

```sh
npx @waswrongassembled/pii-shield db-schema | psql "$DATABASE_URL"
```

```sql
CREATE TABLE IF NOT EXISTS "pii_shield_vault" (
    id text PRIMARY KEY,            -- sha256 hex of the vault id
    payload bytea NOT NULL,         -- ciphertext from EncryptedVault
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS "pii_shield_vault_expires_at_idx" ON "pii_shield_vault" (expires_at);
CREATE TABLE IF NOT EXISTS "pii_shield_learned_types" (
    name text PRIMARY KEY,
    data jsonb NOT NULL             -- the type's JSON, as in the JSON file store
);
```

`postgresSchema({ vaultTable: 'app.pii_vault', typesTable: null })` uses other names, and `null` leaves a table out. A schema in a qualified name must exist already.

### Purging expired vault rows

`get()` ignores expired rows, but they stay in the table until `purgeExpired()` deletes them. The method returns the number of deleted rows. It locks with `SKIP LOCKED`, so several servers can purge at the same time without waiting for each other. Call it on a timer, from a cron job or with `pg_cron`. The HTTP service does it at start and every `PII_SERVICE_VAULT_PURGE_INTERVAL` seconds (default 300).

### Several instances and learned types

`EntityLearner` keeps a snapshot of the learned types, because detection is synchronous. With a shared store (Postgres, Redis, a shared file), types that another instance learns appear only after `learner.refresh()`. The HTTP service and the MCP server refresh before every detection request, as PHP does, so nothing more is needed there. In your own code, call `refresh()` per request or on a timer, depending on how soon new types must apply.

## Data protection

- **Vault: ciphertext only.** `EncryptedVault` encrypts the mapping before it reaches the storage, and the key stays outside the database. Never use a `VaultStorage` on its own for mappings. Ids are stored as SHA-256 hashes, so the table does not reveal the `vaultId` a client holds.
- **Learned types are plaintext.** `examples` and `counterExamples` are stored as they were learned and can contain real personal data. Treat the table like any other store of personal data: restrict access, include it in your records of processing, and handle backups accordingly. Prefer synthetic or anonymised examples.
- **Erasure (Art. 17 GDPR).** `learner.forget(name)` deletes the row. PostgreSQL keeps the deleted tuple in the table file until `VACUUM`, and in WAL archives and backups until they rotate. Account for this in your retention periods, and run `VACUUM` (autovacuum does it eventually) where prompt removal matters.
- **Storage limitation (Art. 5(1)(e) GDPR).** Expired vault rows must really be deleted, not just hidden by the read filter: run `purgeExpired()` regularly.
- **Least privilege.** The application's role needs only `SELECT, INSERT, UPDATE, DELETE` on the two tables. Migrations run with another role:

  ```sql
  GRANT SELECT, INSERT, UPDATE, DELETE ON pii_shield_vault, pii_shield_learned_types TO app_role;
  ```

- **TLS.** Connect with TLS and certificate verification, e.g. `?sslmode=verify-full` in the connection string. Check your driver's documentation for how it reads `sslmode`.
- **Errors.** Errors of the stores never contain values, SQL parameters or the connection string. Errors about stored data use fixed messages and have no `cause`. Driver errors propagate unchanged, so you can still react to their `code` (for example retry a serialization failure, `40001`). A `pg` error's `detail` can quote row values, for example from a constraint you added to the learned types table. Log `name` and `code` and leave `detail` out, as the CLI does. The database URL contains the password: keep it out of logs. The service never prints it.
