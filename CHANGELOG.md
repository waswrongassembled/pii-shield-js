# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-21

### Added

- `@waswrongassembled/pii-shield/postgres`: `PostgresVaultStorage` and `PostgresCustomEntityStore` keep the vault and the learned types in PostgreSQL. They take a driver-agnostic `query(text, params)` function (a `pg` `Pool` or `PoolClient` fits) and work inside the caller's transaction. Vault ids are hashed, expiry uses the database clock, and `purgeExpired()` deletes expired rows. Learned types are stored one row per type. `postgresSchema()` returns idempotent DDL for your migrations; the library never runs DDL itself.
- `@waswrongassembled/pii-shield/testing`: `verifyVaultStorage()` and `verifyCustomEntityStore()` check a store against the contracts, with `node:assert` only, under any test runner. Every built-in store passes them.
- Service: `PII_SERVICE_VAULT_STORE=postgres`, `PII_SERVICE_LEARNED_STORE=postgres` and `PII_SERVICE_DATABASE_URL` (optional peer `pg` 8). Expired vault rows are purged at start and every `PII_SERVICE_VAULT_PURGE_INTERVAL` seconds (default 300). `pii-shield db-schema` prints the DDL. `serviceFromEnv()` takes an `onError` hook for background errors.
- docs/stores.md: the store contracts, writing your own adapter, PostgreSQL and data protection.

### Changed

- The contracts of `VaultStorage` and `CustomEntityStore` are documented in their TSDoc: expired entries read as `null`, `put()`/`save()` overwrite, removing an unknown id or name is a no-op, payloads are binary-safe, `all()` is sorted in byte order, and concurrent writes of different names are kept. `KeyValueCustomEntityStore` does not keep the last rule across processes; its TSDoc now says so.

## [0.1.1] - 2026-11-21

No changes to the library code. First release through the release workflow: staged on npm with Trusted Publishing and a provenance attestation, approved with 2FA (0.1.0 was published by hand without provenance).

### Changed

- Releases are staged with `npm stage publish` and need a 2FA approval on npmjs.com (`docs/RELEASING.md`).

## [0.1.0] - 2026-11-20

First release: a TypeScript port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield) (PHP), wire-compatible with it. Intended differences are listed in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

Privacy and crash bugs of the PHP package are fixed rather than reproduced: names with characters such as ř or Cyrillic letters are no longer dropped by the model detector (as in clarifile PR #95), SVNRs, tax IDs, phone numbers and IBANs written with non-ASCII digits are redacted, tool results of every agent step are redacted, a prompt containing the internal separator no longer fails, and long digit runs, crafted placeholders and learned patterns cannot block or crash redaction. See "PHP bugs fixed in the port" in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

### Added

- Validators with checksums: `isValidAtSvnr()`, `isValidIban()`, `isValidDeTaxId()`.
- Detectors for persons (salutation and letter layout), postal addresses, AT social security numbers, IBANs, tax numbers, file numbers, e-mail addresses, phone numbers, birth dates and license plates; `EntityExtractor` resolves overlaps and priorities, with an allowlist.
- `PiiShield`: reversible redaction with `⟦TYPE_N⟧` placeholders and `restore()` with tolerant placeholder parsing and reports of unknown and unused placeholders; `NullPiiShield`.
- `PiiMasker` with `TypeLabelMask` and `PartialMask` for irreversible masking.
- Vault: `redactToVault()`, `restoreFromVault()`, `forget()`; `EncryptedVault` (XChaCha20-Poly1305, byte-compatible with PHP), `InMemoryVault`, `MemoryVaultStorage`, and `RedisVaultStorage` in `@waswrongassembled/pii-shield/vault-redis` (peer `ioredis`).
- Learned entity types: `EntityLearner`, `learnPattern()`, `CustomEntityDetector`, `LearnedTypesDetector`; stores `JsonFileCustomEntityStore` (PHP's file format), `InMemoryCustomEntityStore` and `KeyValueCustomEntityStore`. Learned patterns run on a bounded backtracking matcher with PCRE semantics.
- `ModelDetector`: model-based detection with PHP's prompt and answer parsing, a required `location` and `acknowledgeExternalTransfer` for external providers; async APIs `redactAsync()`, `extractAsync()`, `maskAsync()`.
- `@waswrongassembled/pii-shield/ai-sdk` (peer `ai@^7`): `piiShieldMiddleware()` redacts every prompt and restores text, reasoning, streams, tool call inputs and structured output; `detectionModel()` adapts an AI SDK model for `ModelDetector`.
- `@waswrongassembled/pii-shield/server`: the HTTP service of the PHP package (`/v1`, `docs/openapi.yaml`) on `node:http` with PHP's request guard, `ServiceApi`, `startServer()`, `createRequestListener()`.
- `@waswrongassembled/pii-shield/mcp` (peer `@modelcontextprotocol/sdk`): the MCP tools `redact_text`, `restore_text`, `mask_text`, `learn_entity_type` and `list_entity_types` over STDIO and Streamable HTTP.
- `pii-shield` CLI: `pii-shield serve`, `pii-shield mcp [--http]`, configured with PHP's environment variables.

[Unreleased]: https://github.com/waswrongassembled/pii-shield-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/waswrongassembled/pii-shield-js/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/waswrongassembled/pii-shield-js/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/waswrongassembled/pii-shield-js/releases/tag/v0.1.0
