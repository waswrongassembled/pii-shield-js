# pii-shield (Node.js)

Reversible PII redaction for LLM applications, with DACH recognizers (AT SVNR, IBAN, tax numbers) and checksum validation.
TypeScript port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield), wire-compatible with the PHP package.

Personal data in a text is replaced by placeholders (`⟦PERSON_1⟧`, `⟦IBAN_1⟧`) before the text goes to a language model; the answer gets the original values back. Detection runs locally (regular expressions plus checksums, optionally a model you choose), so the LLM provider only ever sees placeholders.

**Status:** 0.1.0 (release prepared, see [docs/RELEASING.md](docs/RELEASING.md)), a feature-complete port of the PHP package: detection, redaction and restore, masking, an encrypted vault (in memory, Redis or PostgreSQL), learned entity types, a model-based detector, Vercel AI SDK middleware, an HTTP service, an MCP server and a CLI. See [CHANGELOG.md](CHANGELOG.md).

## Install

```sh
npm install @waswrongassembled/pii-shield
```

Requires Node >= 22.12. The package is ESM only; `require()` works on Node >= 22.12 (require(esm)). The core depends only on `@noble/ciphers`. Optional peer dependencies, needed only for their subpath:

| Subpath                                     | Needs                                         |
| ------------------------------------------- | --------------------------------------------- |
| `@waswrongassembled/pii-shield`             | -                                             |
| `@waswrongassembled/pii-shield/vault-redis` | `ioredis` (5 or 6)                            |
| `@waswrongassembled/pii-shield/postgres`    | - (any driver; `pg` fits)                     |
| `@waswrongassembled/pii-shield/testing`     | -                                             |
| `@waswrongassembled/pii-shield/ai-sdk`      | `ai` (7)                                      |
| `@waswrongassembled/pii-shield/mcp`         | `@modelcontextprotocol/sdk`                   |
| `@waswrongassembled/pii-shield/server`      | - (`/mcp` needs the MCP SDK, Postgres `pg` 8) |

All examples use synthetic data. Every `ts` block in this README is type-checked against the source by `test/readme-examples.test.ts`.

## Redact and restore

```ts
import { PiiShield } from '@waswrongassembled/pii-shield';

const shield = new PiiShield();
const result = shield.redact(
  'Sehr geehrter Herr Johann Beispielmann,\nIhre SVNR 4568 150392, IBAN AT61 1904 3002 3457 3201.',
);

result.redactedText; // 'Sehr geehrter Herr ⟦PERSON_1⟧,\nIhre SVNR ⟦SVNR_1⟧, IBAN ⟦IBAN_1⟧.'
result.mapping; // { '⟦PERSON_1⟧': 'Johann Beispielmann', '⟦SVNR_1⟧': '4568 150392', ... }

// Send result.redactedText to the model, then restore its answer:
const restored = shield.restore('Antwort an ⟦PERSON_1⟧ zu ⟦SVNR_1⟧', result);
restored.text; // 'Antwort an Johann Beispielmann zu 4568 150392'
restored.unknownPlaceholders; // placeholders the model invented: []
```

Detected types: `PERSON`, `EMAIL`, `PHONE`, `IBAN`, `SVNR`, `TAX_ID`, `FILE_NUMBER`, `BIRTH_DATE`, `LICENSE_PLATE`, `ADDRESS` (see `EntityType`), plus your learned types. Choose detectors with `new PiiShield({ detectors: [...] })` (default: `defaultDetectors()`).

## Masking

Irreversible replacement, for logs or analytics. IBANs and phone numbers stay partly visible by default.

```ts
import { PiiMasker } from '@waswrongassembled/pii-shield';

const masker = new PiiMasker({
  strategies: { EMAIL: (entity) => entity.value.replace(/^[^@]+/, '***') },
});

masker.mask('E-Mail j.beispielmann@example.com, IBAN AT61 1904 3002 3457 3201');
// 'E-Mail ***@example.com, IBAN AT61 **** **** **** 3201'
```

## Vault: restore in a later request

The mapping stays on your side, encrypted (XChaCha20-Poly1305) with a TTL; the client only keeps the `vaultId`. Payloads are byte-compatible with PHP's `EncryptedVault`.

```ts
import { EncryptedVault, MemoryVaultStorage, parseVaultKey, PiiShield } from '@waswrongassembled/pii-shield';

const shield = new PiiShield({
  // 32 bytes, base64; generateVaultKey() creates one
  vault: new EncryptedVault({ storage: new MemoryVaultStorage(), key: parseVaultKey(process.env.VAULT_KEY ?? '') }),
  vaultTtl: 900,
});

const { redactedText, vaultId } = await shield.redactToVault('Herrn\nJohann Beispielmann\nSVNR 4568 150392');
// ... later, possibly in another process sharing the storage:
const { text } = await shield.restoreFromVault(redactedText, vaultId);
await shield.forget(vaultId);
```

For several processes use Redis:

```ts
import { Redis } from 'ioredis';
import { EncryptedVault, generateVaultKey } from '@waswrongassembled/pii-shield';
import { RedisVaultStorage } from '@waswrongassembled/pii-shield/vault-redis';

const vault = new EncryptedVault({
  storage: new RedisVaultStorage({ client: new Redis('redis://127.0.0.1:6379') }),
  key: generateVaultKey(), // use the same configured key in every process
});
```

## Learned entity types

Teach a type from examples; a pattern is derived and checked against the counter-examples. Stores: `JsonFileCustomEntityStore` (same file format as PHP), `InMemoryCustomEntityStore`, `KeyValueCustomEntityStore`, `PostgresCustomEntityStore` (see [docs/stores.md](docs/stores.md)).

```ts
import { defaultDetectors, EntityLearner, JsonFileCustomEntityStore, PiiShield } from '@waswrongassembled/pii-shield';

const learner = await EntityLearner.create({ store: new JsonFileCustomEntityStore('var/learned-types.json') });
const { type } = await learner.learn({
  name: 'INSURANCE_NUMBER',
  description: 'Polizzennummer',
  examples: ['VN-2026-000417', 'VN-2025-123456'],
});
type.pattern; // 'VN-\\d{4}-\\d{6}'

const shield = new PiiShield({ detectors: [...defaultDetectors(), learner.detector()] });
shield.redact('Polizze VN-2026-000999').redactedText; // 'Polizze ⟦INSURANCE_NUMBER_1⟧'
```

## Stores: PostgreSQL and your own

A product that already runs PostgreSQL can keep the vault and the learned types in its own database, in its own pool and, where it wants, in its own transactions. `@waswrongassembled/pii-shield/postgres` takes a `query(text, params)` function (a `pg` `Pool` or `PoolClient` fits) and never runs DDL: put `postgresSchema()` (or `pii-shield db-schema`) into your migrations.

```ts
import pg from 'pg';
import { EncryptedVault, generateVaultKey } from '@waswrongassembled/pii-shield';
import { PostgresCustomEntityStore, PostgresVaultStorage } from '@waswrongassembled/pii-shield/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresVaultStorage({ query: pool.query.bind(pool) });
const vault = new EncryptedVault({ storage, key: generateVaultKey() }); // the database only sees ciphertext
const store = new PostgresCustomEntityStore({ query: pool.query.bind(pool) });
await storage.purgeExpired(); // run regularly: expired rows must really be deleted
```

The contracts every store keeps, the conformance suites for your own adapter (`verifyVaultStorage()`, `verifyCustomEntityStore()` from `@waswrongassembled/pii-shield/testing`, runner-agnostic), transactions, purging and data protection: [docs/stores.md](docs/stores.md).

## Model-based detection

`ModelDetector` asks a language model for entities the patterns miss (names without a salutation, free-form addresses). It sends the **unredacted** text to that model, so `location` is required, and an `external` provider also needs `acknowledgeExternalTransfer: true` (data processing agreement, possibly a third-country transfer). It is async: use `redactAsync()`, `redactToVault()` or `maskAsync()`.

```ts
import { defaultDetectors, ModelDetector, PiiShield } from '@waswrongassembled/pii-shield';

const model = new ModelDetector({
  location: 'local',
  // any function from a prompt to the model's text answer; here a local Ollama
  model: async ({ system, user }, { signal }) => {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: 'qwen3:8b',
        stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const body = (await response.json()) as { message: { content: string } };

    return body.message.content;
  },
  timeout: 60_000,
});

const shield = new PiiShield({ detectors: [...defaultDetectors(), model] });
const result = await shield.redactAsync('Rückfragen bitte an Johann Beispielmann.');
```

With the AI SDK, `detectionModel(languageModel, settings)` from `@waswrongassembled/pii-shield/ai-sdk` adapts any AI SDK model.

## Vercel AI SDK middleware

Needs `ai@^7`. The provider only sees placeholders; answers, streams, tool call inputs and structured output come back with the original values.

```ts
import { generateText, type LanguageModel, wrapLanguageModel } from 'ai';
import { PiiShield } from '@waswrongassembled/pii-shield';
import { piiShieldMiddleware } from '@waswrongassembled/pii-shield/ai-sdk';

declare const yourModel: Exclude<LanguageModel, string>; // e.g. openai('...') from @ai-sdk/openai

const model = wrapLanguageModel({
  model: yourModel,
  middleware: piiShieldMiddleware(new PiiShield(), {
    // placeholders the model invented (no personal data)
    onRestore: ({ unknownPlaceholders }) => {
      if (unknownPlaceholders.length > 0) console.warn('Unknown placeholders', unknownPlaceholders);
    },
  }),
});

const { text } = await generateText({ model, prompt: 'Herrn\nJohann Beispielmann\n...' }); // streamText() too
```

Every model call (every step of a tool loop) redacts the whole prompt with one mapping. Files in user or tool messages throw `UnsupportedContentError`: extract their text locally first. Differences to PHP's `PiiShieldProcessor` are listed in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

## HTTP service and CLI

The same API as the PHP service ([docs/openapi.yaml](docs/openapi.yaml), also served at `/v1/openapi.yaml`): `POST /v1/redact`, `/v1/restore`, `/v1/mask`, `/v1/learn`, `GET /v1/entities`, ...

```sh
npx @waswrongassembled/pii-shield serve              # /v1 and /mcp on 127.0.0.1:8088
PII_SERVICE_TOKEN=$(openssl rand -hex 24) PII_SERVICE_VAULT_KEY=... \
  npx @waswrongassembled/pii-shield serve --host 0.0.0.0 --port 8080
```

Without a token only local peers are answered. Configuration (environment variables, Redis, model provider), programmatic use (`startServer()`, `ServiceApi`) and a Docker image: [docs/server.md](docs/server.md).

## MCP server

Tools `redact_text`, `restore_text`, `mask_text`, `learn_entity_type` and `list_entity_types` (PHP's names and schemas), over STDIO or Streamable HTTP (`/mcp` of `pii-shield serve`). Needs `@modelcontextprotocol/sdk`.

```sh
claude mcp add pii-shield -- npx @waswrongassembled/pii-shield mcp
```

```ts
import {
  EncryptedVault,
  EntityLearner,
  generateVaultKey,
  InMemoryCustomEntityStore,
  MemoryVaultStorage,
} from '@waswrongassembled/pii-shield';
import { serveStdio } from '@waswrongassembled/pii-shield/mcp';
import { ServiceApi } from '@waswrongassembled/pii-shield/server';

const api = new ServiceApi({
  vault: new EncryptedVault({ storage: new MemoryVaultStorage(), key: generateVaultKey() }),
  learner: await EntityLearner.create({ store: new InMemoryCustomEntityStore() }),
});
await serveStdio(api); // log to stderr only: stdout belongs to the protocol
```

`restore_text` returns the original values to the MCP client, and in an agent the client is the model: offer it only where the model may see the data.

## Interoperability with PHP

Wire-compatible with `clarifile/pii-shield`, tested against fixtures exported from the PHP package:

- the same detections and placeholders (`⟦TYPE_N⟧`) for the same text, and the same tolerant placeholder parsing on restore;
- vault payloads (`EncryptedVault`): PHP and Node decrypt each other's entries with the same key; the plaintext is byte-identical;
- learned types: `JsonFileCustomEntityStore` reads and writes PHP's JSON file; learned patterns match as in PCRE;
- the model detector's prompts and answer parsing, the HTTP API (status codes, messages, JSON shapes) and the MCP tools.

Not shared: `Entity.offset` is a UTF-16 index (`text.slice(offset, offset + value.length)`), PHP counts code points; they differ only after characters outside the BMP such as emoji. Offsets are not part of any wire format. `RedisVaultStorage` writes raw payloads, PHP's Symfony cache adds its own marshalling. All intended differences: [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

## Limits and security

- Detection is heuristic. Patterns and checksums find structured data reliably, names and addresses only with context (salutations, letter layout) or with the model detector. Check results on your own (synthetic) data before relying on them, and never test with real personal data.
- A `RedactionResult` contains the original values (`mapping`, `entities`). Never log it, put it in error reports or send it to the model; send only `redactedText`. Error messages of this package never contain values.
- The mapping is the key to the data: keep it in your process or in the encrypted vault, keep the vault key out of code and logs, and use a short TTL.
- `ModelDetector` sends the unredacted text to its model. Prefer `local` or `on_premise`; an `external` provider needs `acknowledgeExternalTransfer: true` and, under the GDPR, a legal basis and a data processing agreement.
- The HTTP service speaks plain HTTP: in production put TLS in front and set `PII_SERVICE_TOKEN` (see [docs/server.md](docs/server.md#security)).

## Development

Requires Node >= 22.12.

```sh
npm ci
npm run check           # typecheck, lint, tests, build
npm run check:package   # publint and are-the-types-wrong on the packed package
npm run test:package    # installs the packed tarball into a temp project and imports every subpath
```

Releases: [docs/RELEASING.md](docs/RELEASING.md).

### Fixtures

`fixtures/*.json` record what the PHP package does; the TypeScript code is tested against them.
They are committed, so tests run without PHP. To regenerate them you need PHP >= 8.4 with `ext-sodium` and a checkout of the PHP package with `composer install` done:

```sh
npm run fixtures -- <path-to>/packages/pii-shield
# or: PII_SHIELD_PHP_DIR=<path-to>/packages/pii-shield npm run fixtures
```

Re-exporting from the same PHP commit produces identical files. Intended deviations from PHP are listed in [docs/DEVIATIONS.md](docs/DEVIATIONS.md), findings for the PHP package in [docs/UPSTREAM.md](docs/UPSTREAM.md).
All fixture data is synthetic.

### Vault interop with PHP

The tests decrypt the PHP payloads in `fixtures/vault.json` and re-encrypt them byte for byte. The other direction (PHP reads Node payloads) needs PHP with `ext-sodium` and the PHP package with `composer install` done:

```sh
npm run compat:vault -- /tmp/node-payloads.json   # builds, then writes payloads with random keys
php compat/decrypt-node-payload.php <path-to>/packages/pii-shield /tmp/node-payloads.json
rm /tmp/node-payloads.json                        # holds the keys; never commit it
```

The PHP script decrypts every case with PHP's `EncryptedVault`, compares the mapping (values and order) and checks that PHP encrypts it to the same bytes; it exits non-zero on the first mismatch.
`RedisVaultStorage` stores each payload raw under `prefix + sha256hex(vaultId)` (default prefix `pii_shield_vault.`). PHP's `Psr6CacheStorage` adds Symfony Cache's namespace and marshalling, so sharing one Redis between PHP and Node needs a raw adapter on the PHP side with the same key scheme.

## License and attribution

MIT, see [LICENSE](LICENSE). This is a port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield) (MIT, © the Clarifile contributors); the detection rules, the model prompt, the HTTP API and the MCP tool definitions come from that package.
