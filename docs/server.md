# HTTP service, MCP server and CLI

pii-shield as a service for applications that are not Node or PHP, or when several applications share learned types. The API is the PHP service's: [openapi.yaml](openapi.yaml) (also served at `/v1/openapi.yaml`); a contract test validates every response against it.

## CLI

```sh
pii-shield serve [--port 8088] [--host 127.0.0.1]   # /v1, plus /mcp when @modelcontextprotocol/sdk is installed
pii-shield mcp                                      # MCP over STDIO
pii-shield mcp --http [--port] [--host]             # MCP over Streamable HTTP only (/mcp)
pii-shield db-schema                                # SQL for the Postgres tables, to stdout
```

`SIGINT`/`SIGTERM` stop the server gracefully (running requests finish, at most 10 s). Log lines go to stderr and never contain request text or secrets.

```sh
B=http://127.0.0.1:8088
curl -s $B/v1/redact -H 'Content-Type: application/json' -d '{"text":"Herrn\nJohann Beispielmann\nSVNR 4568 150392"}'
# {"text":"Herrn\n⟦PERSON_1⟧\nSVNR ⟦SVNR_1⟧","vaultId":"…","expiresIn":900,"placeholders":[…]}
curl -s $B/v1/restore -H 'Content-Type: application/json' -d '{"text":"⟦PERSON_1⟧","vaultId":"…"}'
```

MCP clients: `claude mcp add pii-shield -- npx @waswrongassembled/pii-shield mcp`, or in `claude_desktop_config.json` `{"command": "npx", "args": ["@waswrongassembled/pii-shield", "mcp"]}`. Streamable HTTP: `http://127.0.0.1:8088/mcp` with `Authorization: Bearer $PII_SERVICE_TOKEN`. `restore_text` returns the original values to the MCP client, and in an agent the client is the model: use it only where the model may see the data, or restore outside the model with `POST /v1/restore`.

## Environment variables

| Variable                                                                                                   | Meaning                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PII_SERVICE_TOKEN`                                                                                        | Bearer token for `/v1` and `/mcp`. Without it only local peers are answered.                                                                                                    |
| `PII_SERVICE_ONLY`                                                                                         | `1` = service mode: local peers are not trusted; without a token every request gets 503.                                                                                        |
| `PII_SERVICE_ALLOWED_HOSTS`                                                                                | Extra host names to answer (comma-separated), e.g. behind a reverse proxy. Others get 421.                                                                                      |
| `PII_LOCAL_PEERS`                                                                                          | Addresses treated like localhost (IPs or CIDRs, comma-separated); `gateway` = the container's default gateway (Docker port bound to the host's 127.0.0.1 only).                 |
| `PII_SERVICE_HOST`, `PII_SERVICE_PORT`                                                                     | Listen address, default `127.0.0.1:8088` (`--host`/`--port` win).                                                                                                               |
| `PII_SERVICE_MAX_BODY_BYTES`                                                                               | Largest request body, default 2 MiB (413 above).                                                                                                                                |
| `PII_SERVICE_VAULT_KEY`                                                                                    | Vault key, 32 bytes base64 (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Default: a random key per process. Required for Redis and Postgres. |
| `PII_SERVICE_VAULT_STORE`                                                                                  | `memory` (default), `redis` or `postgres`.                                                                                                                                      |
| `PII_SERVICE_VAULT_TTL`                                                                                    | Seconds a mapping lives, default 900.                                                                                                                                           |
| `PII_SERVICE_LEARNED_TYPES`                                                                                | JSON file of learned types (same format as PHP's `JsonFileCustomEntityStore`).                                                                                                  |
| `PII_SERVICE_LEARNED_STORE`                                                                                | `file` (default when the file is set), `memory` (default otherwise), `redis` or `postgres`.                                                                                     |
| `PII_SERVICE_REDIS_URL`                                                                                    | Redis for the `redis` stores (also `PII_DEMO_REDIS_URL`); needs `ioredis`.                                                                                                      |
| `PII_SERVICE_DATABASE_URL`                                                                                 | PostgreSQL for the `postgres` stores (`postgres://user:password@host/db?sslmode=verify-full`); needs `pg` 8. One pool for both stores. Never logged.                            |
| `PII_SERVICE_VAULT_PURGE_INTERVAL`                                                                         | Seconds between deletions of expired vault rows (Postgres), default 300, at most 86400; `0` = off (then delete them yourself). Also runs once at start.                         |
| `PII_SERVICE_MODEL_PROVIDER`                                                                               | Enables `"detection": "model" \| "both"`: `ollama`, `generic` (OpenAI-compatible), `mistral`, `openai`, `anthropic`.                                                            |
| `PII_SERVICE_MODEL`, `PII_SERVICE_MODEL_URL`                                                               | Model name and server URL (Ollama default `http://127.0.0.1:11434`, also `PII_DEMO_OLLAMA_URL`; required for `generic`).                                                        |
| `PII_SERVICE_ACKNOWLEDGE_EXTERNAL`                                                                         | `true` to allow an external provider: detection sends the unredacted text there.                                                                                                |
| `PII_SERVICE_MODEL_TIMEOUT`                                                                                | Seconds per detection, default 170.                                                                                                                                             |
| `PII_SERVICE_MODEL_KEY` / `PII_DEMO_GENERIC_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Provider keys.                                                                                                                                                                  |

Configuration errors stop the CLI at start (exit code 1) with a message that names the variable.

## PostgreSQL

The service never runs DDL. Create the tables once, with a role that may do so, and run the service with a role that only has `SELECT, INSERT, UPDATE, DELETE` on them:

```sh
npx @waswrongassembled/pii-shield db-schema | psql "$ADMIN_DATABASE_URL"
PII_SERVICE_VAULT_STORE=postgres PII_SERVICE_LEARNED_STORE=postgres PII_SERVICE_VAULT_KEY=... \
  PII_SERVICE_DATABASE_URL='postgres://pii_app:...@db.internal/app?sslmode=verify-full' npx @waswrongassembled/pii-shield serve
```

At start the service reads both tables once and stops with a configuration error if one is missing or not readable. The tables have the default names (`pii_shield_vault`, `pii_shield_learned_types`). To keep them in their own schema, create them there and set the search path in the URL (`?options=-c%20search_path%3Dpii`).

Notes:

- Why no automatic `CREATE TABLE`: schema changes belong in the product's migrations and need more rights than the service should have. A service that creates tables silently would also create them in the wrong database after a typo in the URL.
- Expired vault rows are deleted at start and every `PII_SERVICE_VAULT_PURGE_INTERVAL` seconds. Several instances can purge at the same time. Failures are logged as `pii-shield: vault-purge failed (<name> <code>)`, never with the error message or values; errors of idle connections are logged as `database failed`.
- Several instances share vault entries and learned types. Each instance re-reads the learned types before every detection request, so a type learned on one instance applies on all of them at once.
- Data protection (ciphertext only in the vault, plaintext examples in the learned types, erasure and backups, TLS, roles): [stores.md](stores.md#data-protection).

## Docker

The repository's `Dockerfile` builds the package and runs `pii-shield serve` on `node:24-alpine` as the `node` user, with only production dependencies plus the optional peers for `/mcp`, Redis and PostgreSQL. It listens on `0.0.0.0:8088` inside the container.

```sh
docker build -t pii-shield .
# Port bound to the host's 127.0.0.1 only, the host counts as a local peer:
docker run --rm -p 127.0.0.1:8088:8088 -e PII_LOCAL_PEERS=gateway pii-shield
# Anything else: a token, a fixed vault key, and the host names clients use:
docker run --rm -p 8088:8088 -e PII_SERVICE_TOKEN=... -e PII_SERVICE_ONLY=1 \
  -e PII_SERVICE_VAULT_KEY=... -e PII_SERVICE_ALLOWED_HOSTS=pii.example.internal pii-shield
```

Arguments after the image name replace `serve` (e.g. `mcp --http`). Learned types in a file need a volume (`-v pii-data:/data -e PII_SERVICE_LEARNED_TYPES=/data/learned-types.json`; `/data` belongs to the `node` user).

## Programmatic use

```ts
import {
  EncryptedVault,
  EntityLearner,
  InMemoryCustomEntityStore,
  MemoryVaultStorage,
  parseVaultKey,
} from '@waswrongassembled/pii-shield';
import { ServiceApi, startServer } from '@waswrongassembled/pii-shield/server';
import { createMcpHttpHandler, serveStdio } from '@waswrongassembled/pii-shield/mcp';

const api = new ServiceApi({
  vault: new EncryptedVault({ storage: new MemoryVaultStorage(), key: parseVaultKey(process.env.KEY!) }),
  learner: await EntityLearner.create({ store: new InMemoryCustomEntityStore() }),
  token: process.env.PII_SERVICE_TOKEN,
  // modelDetector: () => new ModelDetector({ model, location: 'local' }),
});
const server = await startServer({ api, mcp: createMcpHttpHandler(api), port: 8088 });
// await server.close();
```

`createRequestListener()` mounts the same handler into your own `node:http` server; `api.handle()` and `api.operation()` work without HTTP. `createMcpServer(api)` returns an `McpServer` for any transport.

## Security

- The placeholder mapping is stored encrypted with a TTL; only restore (HTTP and MCP) returns original values, to whoever holds the `vaultId`.
- Which model detects is server configuration only. Model errors are answered generically (502); details go to the `onError` hook, the CLI logs only error name and code.
- JSON only (`Content-Type: application/json`), foreign browser origins rejected (403; on `/mcp` the MCP Inspector's `http://localhost:6274` is allowed), unknown `Host` headers rejected (421, DNS rebinding), no CORS headers, `Cache-Control: no-store`, CSP, `nosniff`, `no-referrer`.
- Token comparison is constant-time. Without a token only 127.0.0.1, ::1 and `PII_LOCAL_PEERS` are answered.
- Plain HTTP: for production put a reverse proxy with TLS in front and set `PII_SERVICE_TOKEN`, `PII_SERVICE_ONLY=1` and `PII_SERVICE_ALLOWED_HOSTS`.
