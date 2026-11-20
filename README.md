# pii-shield (Node.js)

Reversible PII redaction for LLM applications, with DACH recognizers (AT SVNR, IBAN, tax numbers) and checksum validation.
TypeScript port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield), wire-compatible with the PHP package.

**Status:** work in progress, see [docs/PLAN.md](docs/PLAN.md). Detection (validators, detectors, `EntityExtractor`), redaction/restore (`PiiShield`), masking (`PiiMasker`) and the vault (`redactToVault`/`restoreFromVault`, `EncryptedVault`, Redis storage in `@waswrongassembled/pii-shield/vault-redis`) and learning (`EntityLearner`, `learnPattern`, `CustomEntityDetector`, JSON file / key-value / in-memory stores) are ported; the model detector and the bridges follow.

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

Re-exporting from the same PHP commit produces identical files. Intended deviations from PHP are listed in [docs/DEVIATIONS.md](docs/DEVIATIONS.md).
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
