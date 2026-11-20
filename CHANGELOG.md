# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-20

First release: a TypeScript port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield) (PHP), wire-compatible with it. Intended differences are listed in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).

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

[Unreleased]: https://github.com/waswrongassembled/pii-shield-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/waswrongassembled/pii-shield-js/releases/tag/v0.1.0
