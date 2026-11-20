# pii-shield (Node.js)

Reversible PII redaction for LLM applications, with DACH recognizers (AT SVNR, IBAN, tax numbers) and checksum validation.
TypeScript port of [`clarifile/pii-shield`](https://github.com/massiveart/clarifile/tree/main/packages/pii-shield), wire-compatible with the PHP package.

**Status:** work in progress, see [docs/PLAN.md](docs/PLAN.md). Nothing is exported yet.

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

## License

MIT, see [LICENSE](LICENSE).
