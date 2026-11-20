# pii-shield (Node.js)

Reversible PII redaction for LLM applications, with DACH recognizers (AT SVNR, IBAN, tax numbers) and checksum validation.
TypeScript port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield), wire-compatible with the PHP package.

**Status:** work in progress, see [docs/PLAN.md](docs/PLAN.md). Detection (validators, detectors, `EntityExtractor`), redaction/restore (`PiiShield`), masking (`PiiMasker`), the vault (`redactToVault`/`restoreFromVault`, `EncryptedVault`, Redis storage in `@waswrongassembled/pii-shield/vault-redis`), learning (`EntityLearner`, `learnPattern`, `CustomEntityDetector`, JSON file / key-value / in-memory stores) and model-based detection (`ModelDetector` with `redactAsync()`, AI SDK adapter in `@waswrongassembled/pii-shield/ai-sdk`) the Vercel AI SDK middleware (`piiShieldMiddleware`), the HTTP service (`@waswrongassembled/pii-shield/server`, `pii-shield serve`) and the MCP server (`@waswrongassembled/pii-shield/mcp`, `pii-shield mcp`) are ported; the release follows.

## HTTP service, MCP server and CLI

```sh
npx @waswrongassembled/pii-shield serve              # /v1 (docs/openapi.yaml) and /mcp on 127.0.0.1:8088
npx @waswrongassembled/pii-shield mcp                # MCP over STDIO, e.g. claude mcp add pii-shield -- npx @waswrongassembled/pii-shield mcp
PII_SERVICE_TOKEN=$(openssl rand -hex 24) npx @waswrongassembled/pii-shield serve --host 0.0.0.0 --port 8080
```

Same API as the PHP service (`POST /v1/redact`, `/v1/restore`, `/v1/mask`, `/v1/learn`, `GET /v1/entities`, ...), same MCP tools (`redact_text`, `restore_text`, `mask_text`, `learn_entity_type`, `list_entity_types`). Without a token only local peers are answered. `/mcp` and `pii-shield mcp` need `@modelcontextprotocol/sdk` (optional peer dependency). Configuration and programmatic use (`startServer()`, `ServiceApi`, `createMcpServer()`): [docs/server.md](docs/server.md).

## Vercel AI SDK

Needs `ai@^7` (optional peer dependency). The provider only sees placeholders; answers, streams, tool call inputs and structured output come back with the original values.

```ts
import { generateText, wrapLanguageModel } from 'ai';
import { PiiShield } from '@waswrongassembled/pii-shield';
import { piiShieldMiddleware } from '@waswrongassembled/pii-shield/ai-sdk';

const model = wrapLanguageModel({
  model: yourModel,
  middleware: piiShieldMiddleware(new PiiShield(), {
    // placeholders the model invented (no personal data)
    onRestore: ({ unknownPlaceholders }) => {
      if (unknownPlaceholders.length > 0) console.warn('Unknown placeholders', unknownPlaceholders);
    },
  }),
});

const { text } = await generateText({ model, prompt: 'Herrn\nJohann Beispielmann\n…' }); // works with streamText() too
```

Every model call (every step of a tool loop) redacts the whole prompt with one mapping. Files in user or tool messages throw `UnsupportedContentError`: extract their text locally first. Differences to PHP's `PiiShieldProcessor` are listed in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

## Development

Requires Node >= 22.12.

```sh
npm ci
npm run check   # typecheck, lint, tests, build
```

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

## License

MIT, see [LICENSE](LICENSE).
