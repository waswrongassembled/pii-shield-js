# pii-shield for Node.js: port plan

Port of `clarifile/pii-shield` (PHP, MIT, github.com/massiveart/clarifile, `packages/pii-shield`) to TypeScript.
Goal: same detection results and same wire formats, so PHP and Node can redact and restore each other's data.
Not a 1:1 translation: the API and internals follow TypeScript/Node best practices. Only the compatibility contract below is fixed.

Source of truth: the PHP package. Local copy: path in `CLAUDE.local.md` (read-only; never edit it from here).

## Decisions

- **Fully interoperable with PHP:** placeholder format, vault payload and learned-type JSON are byte-compatible.
- **v1 scope:** everything, including the bridges (AI SDK middleware, MCP server, model detector, HTTP service).
- **Publishing:** public repo under the GitHub account `waswrongassembled`, MIT. Keep the original copyright line ("the Clarifile contributors") and add your own. Publish on npmjs.com as `@waswrongassembled/pii-shield` (assumption: npm scope = GitHub name; needs an npm account).
- **Stack:**
  - TypeScript, ESM only, Node >= 22.12 (Node 20 is end-of-life since 30.04.2026; 22.12 loads ESM via `require()`, so CommonJS users are covered without a dual build). CI on Node 22/24/26.
  - Build with plain `tsc` (no bundler: a library with subpath exports ships one file per module; `tsup` is unmaintained). Tests with `vitest`, `eslint` + `prettier`, `tsc --strict`.
  - TypeScript 6.0 until `typescript-eslint` supports newer versions.
  - Core has zero runtime dependencies except `@noble/ciphers` (XChaCha20-Poly1305; Node crypto lacks it).
- **Package layout:** one package with subpath exports; the bridge peer deps are optional.
  - `@waswrongassembled/pii-shield`: core.
  - `.../vault-redis`: Redis storage, peer `ioredis`.
  - `.../ai-sdk`: Vercel AI SDK middleware, peer `ai`.
  - `.../mcp`: MCP server, peer `@modelcontextprotocol/sdk`.
  - `.../server`: HTTP service plus the `pii-shield` CLI binary.

## Idiomatic TypeScript, not a PHP transliteration

Port behaviour, not structure. Where PHP idioms and TS idioms differ, use the TS one:

- **API shape:** options objects instead of long positional parameter lists (`new PiiShield({ detectors, vault, vaultTtl, allowlist })`); plain factory functions where a class adds nothing (e.g. `createPiiShield()`).
- **Types:** `interface`/`type` for contracts (`Detector`, `Vault`, `VaultStorage`, `MaskingStrategy`); `EntityType` as a string-literal union plus a frozen const object, no TS `enum`. Entities and results are readonly plain objects, not classes with getters.
- **Interfaces stay small:** a detector is `(text: string) => Entity[]` or `{ detect(text) }`; masking strategies may be functions. No PHP-style `...Interface` suffixes.
- **Async where I/O happens:** vault, vault storage, learned-type stores and the model detector return Promises. Pure detection, redaction without vault, masking and restore stay synchronous.
- **Errors:** one `PiiShieldError` base class extending `Error`, subclasses per kind (`VaultError`, `LearningError`, ...) with a stable `code` string and `cause`. Messages stay identical to PHP where clients see them (learning validation, vault, HTTP/MCP), because they are part of the service API.
- **Resource handling:** `AbortSignal` for model calls, `Symbol.asyncDispose` where something holds a connection, no global state.
- **Naming:** camelCase, no `get` prefixes on plain properties, file names in kebab-case.
- **Tests:** port the PHP cases as `it.each` tables plus the fixtures; test the TS API, not PHP internals (e.g. `TextSpans` and `RegexMatcher` may disappear if TS does not need them).

Every API difference that changes observable behaviour (not just shape) goes into `docs/DEVIATIONS.md`.

## Compatibility contract (must hold, has tests)

1. **Placeholder:**
   - Canonical form `⟦TYPE_N⟧`; the type is the `EntityType` value or a learned name.
   - Restore accepts the tolerant variants, e.g. `[[type n]]` or `⟦TYPE\_N⟧` (port `Placeholder::TOLERANT_PATTERN`).
2. **EntityType values:** `PERSON ADDRESS SVNR IBAN TAX_NUMBER FILE_NUMBER EMAIL PHONE BIRTH_DATE LICENSE_PLATE ID_NUMBER CREDIT_CARD IP_ADDRESS HEALTH OTHER`.
3. **Vault payload:**
   - Format: `nonce(24) || XChaCha20-Poly1305-IETF(ciphertext+tag)`.
   - AAD is the vault id; the plaintext is the JSON object `{placeholder: original}`.
   - The key is 32 raw bytes, base64 as a secret.
   - Test: decrypt a payload produced by PHP (fixture), and PHP decrypts a Node payload (script in `compat/`).
   - PHP encodes an empty mapping as `[]`, not `{}`. Node must accept both when reading; PHP reads `{}` fine.
4. **Learned types:** the JSON file has the same shape as `JsonFileCustomEntityStore` / `CustomEntityType::toArray()`, with the same limits and validation messages.
5. **Detection results:** for the same text, Node finds the same entities (type, label, value, confidence, detector name) as PHP. **Offsets differ on purpose:** PHP counts code points, Node uses UTF-16 indices like every JS string API, so `text.slice(e.offset, e.offset + e.value.length)` works. Offsets are not part of any wire format (HTTP and MCP do not expose them). The fixtures keep PHP's code points; the tests convert. Listed in `docs/DEVIATIONS.md`.

Known gap: in PHP the vault sits behind PSR-6 (Symfony Cache adds a namespace and a marshaller). Sharing one Redis between PHP and Node needs a raw storage adapter on both sides with an agreed key prefix. Interop is guaranteed at the payload level; shared Redis works only when both sides use the raw adapter (optional addition on the PHP side, not part of v1).

## Parity strategy: shared test vectors

- `compat/export-fixtures.php` runs the PHP package and writes `fixtures/*.json`:
  - per detector and validator: valid/invalid samples with the expected entities;
  - per fixture letter: the `redact()` output (text + mapping) and `mask()`;
  - learning: inputs → stored JSON or exact error message;
  - vault: key, id, mapping, payload.
- Vitest runs these fixtures against the TS code. A deviation counts as a bug, unless documented in `docs/DEVIATIONS.md`.
- Port the PHP tests themselves too (table-driven), not only the fixtures.
- Synthetic data only, from the existing PHP fixtures. No real letters or names.

## Porting pitfalls

- **Regex:**
  - `/u` → `u` flag (`\p{L}`, `\p{N}` work); `\G` + offset → sticky `y` with `lastIndex`.
  - Named groups `(?<n>)` are fine; atomic or possessive groups were not found (re-check per file).
  - `preg_split` / `preg_replace` semantics (limits, empty matches, `PREG_SPLIT_*` flags) must be replicated exactly.
- **PHP's /u sets PCRE2_UCP** (found in phase 1–3): `\d`, `\w`, `\b` and `\s` are Unicode-aware in every `/u` pattern, not ASCII.
  - Use the classes in `src/internal/pcre.ts` (`DIGIT` = `\p{Nd}`, `WORD` = `[\p{L}\p{N}\p{Mn}\p{Pc}]`, `SPACE`, `WORD_START`/`WORD_END` for `\b`); they were compared code point by code point with PHP 8.5 / PCRE2 10.49.
  - JS `\w`/`\b` with the `i` flag also match `ſ` and `K` (U+212A); the explicit `WORD` class avoids that difference.
  - `^`/`$` with `/m` only see `"\n"` in PHP; JS also breaks at `\r`, U+2028, U+2029 → `LINE_START`/`LINE_END`.
- **Patterns without /u run on bytes:** `\d`/`\s`/`\w` are ASCII, `\R` also matches the byte 0x85 (inside UTF-8 characters like `Å`), and `$` matches before a final `"\n"` (`DeTaxIdValidator` accepts `"86095742719\n"`). `AuthorityContext` counts its sentence window and letterhead limit in UTF-8 bytes and can cut a character; the port reproduces this on encoded bytes. Edge cases are exported as `pcre: …` cases in `fixtures/detectors.json`.
- **Ranking by length** (`EntityExtractor` overlaps) counts code points, not UTF-16 units, or values with astral characters rank differently.
- **PatternGrammar** checks user patterns (safe subset, at most one unbounded quantifier, length limit) and compiles them to PCRE `~(?:…)~u`. In TS they become `new RegExp('(?:…)', 'u')`. The grammar must reject everything that behaves differently in PCRE and JS, so the same pattern means the same thing on both sides. This is a safety and parity risk: test it most thoroughly.
- **PCRE vs. JS character classes** (seen in `fixtures/learning.json`, grammar probes): with `/u`, PCRE `\s` matches U+00A0 and U+2028 but not U+FEFF, JS `\s` matches all three; PCRE `.` matches U+2028, JS `.` does not. `[]a]` is a valid class in PCRE and a syntax error in JS. Learned patterns must translate these, or the grammar must reject them.
- **ReDoS:** PHP survives catastrophic backtracking only by throwing at `pcre.backtrack_limit`; JavaScript has no limit and hangs. Every ported pattern needs a bounded run time on adversarial input (`test/redos.test.ts`); emulate atomic groups with `(?!\d)`-style guards or `(?=(…))\1`.
- **String functions:** offsets are UTF-16, but length limits and masking that PHP counts with `mb_*` (e.g. `MAX_EXAMPLE_LENGTH`, `PartialMask`) must count code points (`[...s]`) to reject and mask exactly what PHP does. `strtoupper` is ASCII-only in PHP; `toUpperCase()` is not, so for type names use an ASCII-only helper.
- **Placeholders** (found in phase 4–5): the tolerant pattern is `/u` (Unicode `\s`, `\d` = `\p{Nd}`, so `⟦PERSON_١⟧` is found and stays non-ASCII), but PHP normalizes the separators inside the type with a pattern _without_ `/u`: only ASCII whitespace becomes `_`, a no-break space inside the type survives and makes the placeholder unknown. Cases in `fixtures/redaction.json` → `restore.cases`.
- **Mappings are insertion-ordered:** PHP arrays keep insertion order, and placeholders (`⟦…`) are never integer-like keys, so a plain object keeps the same order. Person full names are numbered before everything else (PHP iterates `[...fullNames, ...entities]`), so `⟦PERSON_2⟧` can precede `⟦IBAN_1⟧` in the mapping.
- **ctype_space** on one character is ASCII-only (`\t\n\v\f\r` and space): `PartialMask` masks a no-break space.
- **Checksums:** use integer arithmetic for the IBAN mod 97 (BigInt or chunked), SVNR and tax ID.
- **Vault plaintext** (found in phase 6): PHP's `json_encode()` escapes `/` as `\/` and every non-ASCII UTF-16 unit as a lowercase `\u` escape, an empty mapping is `[]`; `src/internal/php-json.ts` reproduces it, so the same nonce gives the same payload. When reading, `json_decode(…, true)` turns integer-like keys (`"1"`, `"-7"`, within int64) into ints, which PHP's `is_string()` check rejects as corrupt: the port rejects them too. Decode with a fatal `TextDecoder` and `ignoreBOM: true` (PHP rejects invalid UTF-8 and a BOM), build the mapping with `Object.fromEntries` (`__proto__` stays a key), and never attach a `JSON.parse` error as `cause`: V8 quotes the plaintext in its message.
- **Learned patterns** (found in phase 7): they are not translated to a JavaScript `RegExp` but run on a small backtracking matcher for the grammar subset (`src/learning/learned-pattern.ts`) with PCRE semantics: UCP `\d \w \s`, `.` = everything but `"\n"`, `[]a]`, `[a-b-c]`, an unescaped `~` is invalid (it ends PHP's delimiters), `$` also before a final `"\n"`, and after an empty match `preg_match_all()` retries non-empty at the same place (`x{0}|VN-\d+` finds `VN-12`). It counts choice points and backtracks per start position like PCRE2's JIT does with `pcre.backtrack_limit` (calibrated: `.{0,45}` three times passes, `.{0,46}` does not; 15 `(?:a|a)` pass, 16 do not), skips choice points for runs that cannot give characters back (auto-possessification) and adds a budget linear in the text per `matchAll()`, so detection never hangs. A differential test against `RegExp` checks the backtracking order.
- **PatternLearner** tokenizes with `ctype_digit()` (ASCII) and `trim()` (ASCII), so Arabic digits and a no-break space become literals; it escapes `= ! < > :`, which the grammar then rejects (`fixtures/learning.json` → `learnerEscapes`).
- **Learned-type JSON:** `json_encode()` with `JSON_UNESCAPED_UNICODE` still escapes U+2028/U+2029; otherwise `JSON.stringify(…, null, 4)` is byte-identical.
- **Model detector** (found in phase 8):
  - PHP's `trim($value, "…„“”‚‘’«»")` trims _bytes_, so a value ending in `ř`, `р` or `ę` (or starting with `€`) loses a byte, becomes invalid UTF-8 and is dropped; the port trims characters (docs/DEVIATIONS.md).
  - `CITATION_BEFORE` backtracks exponentially in JavaScript (`Ziff` is `Z` + `iff` or a keyword); it is decided by a linear right-to-left pass, and the file number keyword check strips its trailing `[ \t]*:?[ \t]*` first. Differential tests against PHP's patterns in `test/redos.test.ts`. `<think>…</think>` is removed by `indexOf`, not a lazy regex.
  - Windows count code points (chunks, the 30 characters before a birth date), the postcode lookahead counts 120 UTF-8 _bytes_ and finds nothing when the cut splits a character. `\d` is UCP in the date and citation checks but ASCII in the file number digit check.
  - The prompt's learned-type JSON uses `JSON_HEX_*` escapes (`\u0027`, `\u0022`, `\u0026`, upper-case hex), escapes `/` and U+2028/U+2029; `src/model/prompt.ts` builds the escapes from code points because the tool layer mangles `\u` literals.
  - Detectors see the normalized text (`\r\n` → ` \n`), so the model gets it too, as in PHP.
- **AI SDK middleware** (found in phase 9):
  - The mapping travels from `transformParams` to `wrapGenerate`/`wrapStream` in a `WeakMap` keyed by the returned params object (`wrapLanguageModel` hands that same object on), like PHP's `WeakMap` on the `MessageBag`; it never enters the call options.
  - A tool loop calls the model once per step with the whole history, so the history must be redacted again each time: restored tool call inputs, restored reasoning and tool results would otherwise go back in clear text (PHP redacts only once per `Agent::call()`).
  - Restored values in JSON (tool inputs, JSON mode) must be JSON-escaped: an address contains `\n`. Tool inputs are parsed and string keys and values restored (PHP's `StructuredRestorer` keeps keys; keys can carry PII); unparsable JSON and JSON-mode text are restored textually with escaped values.
  - Streams: hold a possible placeholder (`[`, `[[`, `⟦`, `⟦TAX\`) until complete or impossible; the automaton next to `TOLERANT` (`stepPlaceholderPrefix()`) must accept exactly its prefixes (property tests against `restore()` of the whole text). Keep a split surrogate pair together (astral `\p{Nd}` digits), keep the held state incremental (rescanning the held text per chunk was quadratic), and give up a candidate after 1024 units.
  - `@ai-sdk/provider` is not a dependency of ours: derive the V4 types from `LanguageModelMiddleware` (exported by `ai`); import `ai` only as a type in the middleware.
- **HTTP service and MCP** (found in phase 10–11):
  - PHP's controller decodes the body with `json_decode(…, true, 16)` before authentication: invalid JSON is a 400 even without a token. Depth 16 allows 15 nested containers; invalid UTF-8, a BOM and escaped lone surrogates are invalid JSON there but not for `JSON.parse()` (`src/service/json-body.ts`). A JSON list is a PHP array, so it is accepted as a body (with no fields), and a JSON object where a list of strings is expected counts as its values.
  - `$body[$key] ?? default`: `null` counts as missing (`"detection": null` is `regex`). Read fields with `Object.hasOwn()`, never `body[key]` alone (`"constructor"`).
  - Error precedence follows PHP's argument evaluation order: detectors (detection, model configured, types) before allowlist before text.
  - The guard compares `Origin` with `http://` + the lower-cased Host header (port kept unless 80), strips `:port` from the host with `/:\d+$/` (so `[::1]` stays), and checks `Content-Type` with a case-sensitive `startsWith('application/json')`. Symfony's router matches the URL-decoded path (`/v1/%6Dask` is `/v1/mask`); decode like `rawurldecode()`.
  - IpUtils compares `127.0.0.1` exactly (not 127/8). Node reports IPv4 peers on a dual-stack socket as `::ffff:127.0.0.1`: unmap before comparing.
  - PHP's MCP SDK returns a tool's array as pretty-printed JSON text (4 spaces, unescaped Unicode and slashes) plus `structuredContent`, API errors as `isError` results, schema violations as JSON-RPC -32602 with the first violation. The TS SDK's `McpError` prefixes its message with "MCP error -32602: " on the wire; throw an `Error` with a numeric `code` to send PHP's exact message. `McpServer.registerTool()` wants zod schemas: set the `tools/list` and `tools/call` handlers on `mcp.server` to keep PHP's JSON schemas.
  - While closing, keep-alive connections that finish a response must be closed explicitly, or `server.close()` waits for the keep-alive timeout.
- **Async validation:** vault methods are `async`, so a bad TTL rejects the Promise instead of throwing synchronously (PHP throws). Constructor arguments (`key`, `vaultTtl`) still throw synchronously.
- **Secrets:** wipe buffers after use (`buf.fill(0)`) instead of `sodium_memzero`. Keep the key out of logs and errors.
- **Error messages:** never contain PII values (PHP names positions, not values). Keep the wording of client-facing messages (see "Idiomatic TypeScript").

## Phases (each phase: tests green, lint green, own PR)

0. **Scaffold** (done): repo, tsconfig, tsc build, vitest, eslint, CI (GitHub Actions on Node 22/24/26), LICENSE, README skeleton. Write `compat/export-fixtures.php` and generate fixtures.
1. **Validators** (done): `AtSvnrValidator`, `IbanValidator`, `DeTaxIdValidator`.
2. **Detectors** (done):
   - `RegexMatcher`, `AuthorityContext`;
   - Email, Phone, Iban, AtSvnr, TaxNumber, FileNumber, BirthDate, LicensePlate, PostalAddress, SalutationPerson.
3. **Extraction** (done): `Entity`, `EntityType`, `EntityExtractor` (overlaps, word boundaries, priority). `TextSpans` moves to phase 4 (with UTF-16 offsets it is a plain slice loop).
4. **Redaction** (done): `Placeholder`, `RedactionResult`, `RestoreResult`, `PiiShield.redact/restore`, `NullPiiShield`.
5. **Masking** (done): `PiiMasker`, `TypeLabelMask`, `PartialMask`.
6. **Vault** (done):
   - `InMemoryVault`, `EncryptedVault`, storage interface, Redis adapter;
   - `restoreFromVault`, `forget`, TTL; async methods next to the sync ones (`redactToVault(text): Promise<RedactionResult & { vaultId }>`), the sync `RedactionResult` has no `vaultId`;
   - compat test against PHP payloads.
7. **Learning** (done):
   - `CustomEntityType`, `PatternGrammar`, `PatternLearner`, `EntityLearner` (learn/preview/forget/types);
   - stores: JSON file (with file locking), in-memory, and a cache store via a small KV interface;
   - `LearnedTypesDetector`, `CustomEntityDetector`.
8. **Model detector** (done): port of `ModelDetector` + `ModelLocation`.
   - Provider-agnostic: `model` is a function `({ system, user }, { signal }) => Promise<string>` or `{ name, generate }`; `detectionModel(languageModel, settings)` from the `ai-sdk` subpath adapts an AI SDK `LanguageModel` (peer `ai`, the core stays dependency-free).
   - Same prompt, same JSON parsing, same context checks (`fixtures/model.json`: PHP's prompts, chunks and parse results over a fake platform).
   - Same guard: `location` (`local` | `on_premise` | `external`) is required, an external provider needs `acknowledgeExternalTransfer: true` (PHP's parameter name, ADR 0006).
   - `ModelDetector` is an `AsyncDetector` (`async: true`); `extractAsync()`, `redactAsync()`, `redactToVault()` and `maskAsync()` run it, the sync APIs throw a `TypeError` before anything is sent. `DetectionError` (`DETECTION_MODEL_UNREACHABLE`, `DETECTION_INVALID_ANSWER`, `DETECTION_TEXT_TOO_LONG`), `AbortSignal` and an optional `timeout`.
9. **AI SDK middleware** (done; replaces `PiiShieldProcessor` + `StructuredRestorer`):
   - `wrapLanguageModel({ middleware: piiShieldMiddleware(shield) })` from `.../ai-sdk`, peer `ai@^7` (LanguageModelV4 middleware; v6 speaks V3 and is not supported);
   - redacts the whole prompt of every model call in one pass (one mapping), restores text, reasoning, tool call inputs, stream deltas (placeholders that span chunk boundaries) and structured output;
   - `onRestore` reports invented placeholders, `onRedact` the placeholders (and with `vault: true` the vault id); files in user/tool messages throw `UnsupportedContentError`.
10. **MCP server** (done): same tools as `demo/src/Mcp/PiiShieldTools.php` (`redact_text`, `restore_text`, `mask_text`, `learn_entity_type`, `list_entity_types`; PHP's names, descriptions, input schemas, annotations, instructions) in `.../mcp`, peer `@modelcontextprotocol/sdk` (optional). STDIO (`serveStdio()`) + Streamable HTTP (`createMcpHttpHandler()`, stateful sessions, JSON answers, guarded like /v1).
11. **HTTP service** (done): `ServiceApi` (`src/service/`, shared by HTTP and MCP) with the endpoints, JSON shapes, status codes and messages of `docs/openapi.yaml` (contract test validates every response against the spec), `startServer()` / `createRequestListener()` on plain `node:http` with PHP's RequestGuard rules, graceful shutdown; `pii-shield serve` / `pii-shield mcp [--http]` CLI configured from PHP's env names (docs/server.md).
12. **Release** (prepared; the first publish is still to do, see docs/RELEASING.md):
    - README (quick start, interop, offsets, limits; its `ts` examples are type-checked by `test/readme-examples.test.ts`) and CHANGELOG;
    - package checks: `npm run check:package` (publint, are-the-types-wrong with the ESM-only profile), `npm run test:package` (installs the packed tarball, preferring the npm cache, and imports every subpath via `import` and `require()`, type-checks them, runs the bin), both in CI;
    - `npm publish --provenance` via GitHub Actions (`.github/workflows/release.yml`, trusted publishing, tag must match the version);
    - version 0.1.0; a Dockerfile for the service (docs/server.md).
13. **Store adapters, Postgres** (done): a product that already runs Postgres keeps the vault and the learned types in its own database, in its own connection pool and, where it wants, in its own transactions. Not in PHP (it has PSR-6 cache and file stores only): a Node-only addition, listed in docs/DEVIATIONS.md.
    - **Store contracts first.** Write down in the TSDoc of `VaultStorage` and `CustomEntityStore` what every backend must do:
      - `get` of an unknown or expired id gives `null`. Expiry is checked on read, not left to a cleanup job.
      - `put` and `save` overwrite, `remove` of an unknown id is a no-op, payloads are binary-safe, and `all()` is sorted by name.
      - Concurrent `save`/`remove` of different names must not lose each other's writes (the KeyValue store's read-modify-write does, see its TSDoc).
    - **Conformance suites** in a new subpath `.../testing`: `verifyVaultStorage(factory)` and `verifyCustomEntityStore(factory)` check the contract with `node:assert` and an injectable clock where the backend allows it, so they run under any test runner without a vitest peer.
      - Run them against every built-in store: memory, JSON file, KeyValue, Redis fake, Postgres.
      - Custom adapters in a product run the same suite.
    - **`.../postgres` subpath, no driver dependency:**
      - `PostgresVaultStorage` and `PostgresCustomEntityStore` take a `query: (text, params) => Promise<{ rows }>` function. A `pg` `Pool`, a `PoolClient` inside a transaction, or a wrapper around another driver all fit.
      - Table names are configurable and validated as identifiers, never interpolated unchecked. Values always go in as parameters.
      - Schema: the vault table has `id text primary key, payload bytea, expires_at timestamptz` with an index on `expires_at`. Learned types get one row per name (`name text primary key, data jsonb`), so concurrent writes of different names do not conflict.
      - The DDL is exported as SQL (`postgresSchema({ vaultTable, typesTable })`) for the product's own migrations. The library never runs migrations itself.
      - Expiry uses the database clock (`now()`), not the app clock. `purgeExpired()` deletes expired rows, for a cron job or `pg_cron`.
    - **Server:** `PII_SERVICE_VAULT_STORE=postgres` and `PII_SERVICE_LEARNED_STORE=postgres` with `PII_SERVICE_DATABASE_URL` in `serviceFromEnv` (optional peer `pg`, loaded lazily like `ioredis`). `ServiceApi` already takes any `Vault` and `EntityLearner` programmatically.
    - **Tests:** unit tests over a fake `query`. Integration tests and the conformance suite run against a real Postgres: a CI service container, skipped locally without `PII_TEST_DATABASE_URL`.
    - **docs/stores.md:**
      - Write your own adapter: the contracts, the conformance suite, and a Postgres example in the product's transaction.
      - Data protection:
        - The vault only ever stores ciphertext, so the key stays outside the database.
        - Learned types (`examples`, `counterExamples`) are plaintext and can hold real personal data. Treat their table as personal data: access rights, backups, deletion through `forget`.
        - Expired vault rows must really be deleted (storage limitation, Art. 5(1)(e) GDPR), not just hidden by the read filter: run `purgeExpired()` regularly.
    - **Deviations from this plan, found while building it:**
      - The conformance suites have no injectable clock. A database or Redis keeps its own time. Instead, an `expire(storage, id)` hook makes one entry expired (for Postgres: `UPDATE … SET expires_at = now() - interval '1 second'`); `realTimeExpiry: true` waits for a real 1 s TTL instead. Without either, the expiry rules are reported as skipped. `secondInstance` adds the rules that need two instances over one backend. The suites return `{ passed, skipped }`.
      - The query function needs only `{ rows }`, no `rowCount`: `purgeExpired()` gets its count from `RETURNING` and `count(*)`, so wrappers around other drivers stay trivial. The purge locks with `FOR UPDATE SKIP LOCKED`, so purges of several servers neither block nor deadlock each other.
      - `all()` sorts in JavaScript with `sortByName()`, not with `ORDER BY … COLLATE "C"`: one byte-order rule for every store, whatever the database collation.
      - Table names are at most 48 characters per part, so the derived index name (`<table>_expires_at_idx`) stays within PostgreSQL's 63.
      - The server never creates tables: `pii-shield db-schema` prints the DDL, and the service checks at start that both tables are readable. Silent DDL would need a privileged role and could create tables in the wrong database.
      - No periodic `learner.refresh()` in the server: `ServiceApi` already refreshes the learned types before every detection request (as PHP reads its store each time), so shared stores are never stale there. docs/stores.md tells products that use `EntityLearner` directly to refresh per request or on a timer.
      - Driver errors are not wrapped: products need their `code` (for example to retry `40001`). Errors from parsing stored data have fixed messages without `cause`. The docs say to log a pg error's `name` and `code` but not its `detail`. Error messages of `serviceFromEnv()` never contain the database URL or its password (validated with a fixed message, scrubbed from driver messages).

## Way of working

- Its own Claude session in this repo. Work phase by phase, one subagent per phase with this plan + the matching PHP files as its brief.
- Per phase: port the PHP tests first, then the code (TDD); fixtures must be green.
- Never send PII to an LLM provider; tests run offline. The model detector is tested with a fake.
