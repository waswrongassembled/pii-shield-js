# Deviations from the PHP package

Behaviour that intentionally differs from `clarifile/pii-shield`. A fixture mismatch that is not listed here is a bug.
Pure API shape (options objects, Promises, error classes) is not listed; see "Idiomatic TypeScript" in [PLAN.md](PLAN.md).

Rule for PHP bugs (numbers refer to [UPSTREAM.md](UPSTREAM.md)): privacy and crash bugs are not reproduced for parity. The port fixes them, names the PHP reference and has a test; fixture cases that record the PHP bug are listed in `FIXED_IN_PORT` (`test/support/fixtures.ts`) and checked in `test/php-bugs-fixed.test.ts`. Correctness bugs without privacy impact stay at parity, listed under [PHP bugs deliberately reproduced](#php-bugs-deliberately-reproduced-php-fix-pending).

## PHP bugs fixed in the port

| UPSTREAM | PHP                                                                                                                                                                                         | Port                                                                                                                                                                     | Test                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| #1       | `ModelDetector` trims bytes and drops "Jan Kovář", "Александр", "€12"                                                                                                                       | trims characters, as clarifile PR #95 does (see [Model answers](#model-answers-values-are-trimmed-by-character))                                                         | `test/model-detector.test.ts`                                        |
| #2       | `PiiShieldProcessor` redacts once per `Agent::call()` (documented in pii-shield `docs/library.md`, "Tool results are not redacted")                                                         | every model call is redacted (see [AI SDK middleware](#ai-sdk-middleware-instead-of-the-symfony-ai-processor))                                                           | `test/ai-sdk-middleware.test.ts` "redacts every step of a tool loop" |
| #4       | `AtSvnrValidator`, `DeTaxIdValidator`, `IbanValidator`, `PhoneDetector`'s digit count and `ModelDetector`'s file number check accept ASCII digits only, the detectors match `\d` under `/u` | any decimal digit (`\p{Nd}`) counts (see [below](#decimal-digits-other-than-ascii))                                                                                      | `test/php-bugs-fixed.test.ts`                                        |
| #5       | `PhoneDetector::PATTERN` throws on long digit runs                                                                                                                                          | PR #95's pattern (see [Phone detection](#phone-detection-does-not-fail-on-long-digit-runs))                                                                              | `test/redos.test.ts`                                                 |
| #6       | `ModelDetector`: `CITATION_BEFORE` exponential, file number keyword check and `<think>` removal quadratic                                                                                   | linear (see [Citation checks](#citation-and-file-number-checks-of-model-findings))                                                                                       | `test/redos.test.ts`                                                 |
| #7       | `Placeholder::replaceAll()` throws "JIT stack limit exhausted"                                                                                                                              | never throws (see [Restore](#restore-never-fails-on-pathological-placeholder-input))                                                                                     | `test/placeholder.test.ts`, `test/redos.test.ts`                     |
| #8       | `CustomEntityType::runsInBoundedTime()` per start position only; `CustomEntityDetector` quadratic                                                                                           | overall budgets (see [Learned patterns](#learned-patterns-backtracking-budget), [bounded-time check](#the-bounded-time-check-of-learned-patterns-has-an-overall-budget)) | `test/redos.test.ts`                                                 |
| #9       | the HTTP service reads bodies of any size                                                                                                                                                   | 2 MiB limit (see [HTTP service](#http-service-and-mcp-server))                                                                                                           | `test/server.test.ts`                                                |
| #11      | `PiiShieldProcessor` throws a `LogicException` when a text contains its separator                                                                                                           | the separator gets longer (see [AI SDK middleware](#ai-sdk-middleware-instead-of-the-symfony-ai-processor))                                                              | `test/ai-sdk-middleware.test.ts`                                     |
| #20      | `EncryptedVault::fetch()` chains the `JsonException` as `previous`                                                                                                                          | fixed message "Vault entry is corrupt.", no `cause` (V8's `JSON.parse()` message quotes the plaintext)                                                                   | `test/vault.test.ts`                                                 |

## Decimal digits other than ASCII

PHP's detectors match `\d` under `/u`, i.e. any decimal digit (fullwidth `４`, Arabic-Indic `٤`, Devanagari `४`, ...), but its validators and digit counts accept ASCII digits only, so an SVNR, tax ID, phone number or IBAN check digit written with such digits is found and then dropped: it reaches the provider unredacted. The port maps every `\p{Nd}` digit to its ASCII value before validating (`isValidAtSvnr()`, `isValidDeTaxId()`, `isValidIban()`, the phone detector's 7-digit minimum and mobile number check, the SVNR birth date check) and counts any decimal digit in a model's file number. Entity values keep the original characters. The PHP results of these cases are in the fixtures (`FIXED_IN_PORT`).

## Entity offsets are UTF-16 indices

PHP reports `Entity.offset` in code points (`mb_*`). Node reports UTF-16 indices, so `text.slice(offset, offset + value.length)` returns the value. The two differ only when characters outside the BMP (e.g. emoji) precede the entity. Offsets are not part of any wire format.

## Lone surrogates instead of invalid UTF-8

PHP's regex functions fail on invalid UTF-8 (the detectors then throw). A JavaScript string is never invalid UTF-8, but it can contain lone surrogates; the port treats them as ordinary characters and does not throw.

## Unicode version of character properties

`\p{L}`, `\p{Lu}`, `\p{Nd}` and the other classes follow the Unicode version of the runtime (Node 24: Unicode 17), PHP's follow PCRE2's. Results only differ for characters assigned in between.

## Phone detection does not fail on long digit runs

The port uses the pattern of clarifile PR #95 (`(?:[ \/-]?\d{2,}(?!\d)){1,5}`); this section applies to PHP releases before it. PHP's phone pattern backtracks catastrophically on a long digit run followed by a letter (e.g. 160 digits and "a"): `preg_match_all` hits `pcre.backtrack_limit` and the whole redaction throws. The port uses an equivalent pattern without the blow-up (each digit group must end where its digit run ends), so it returns the same matches PHP finds on normal input and keeps working on such input. `test/redos.test.ts` checks the equivalence on random texts and bounds the run time of every detector.

## Restore never fails on pathological placeholder input

PHP's `Placeholder::replaceAll()` throws a `RuntimeException` ("Placeholders could not be parsed: JIT stack limit exhausted") when PCRE runs out of JIT stack, e.g. for an unclosed `[[A` followed by thousands of ` 1` tokens. JavaScript's regex engine has no such limit: `replacePlaceholders()` and `restore()` return the text with that span unchanged (it is no placeholder). The matching cost stays linear for such input.

## Vault-backed redaction is a separate async method

PHP's `redact()` stores the mapping when a vault is configured and sets `RedactionResult::$vaultId` (else `null`). The port keeps `redact()` synchronous and vault-free: `redactToVault()` returns a Promise of the result plus `vaultId`, and throws when no vault is configured (PHP returns `vaultId = null`). `restoreFromVault()` and `forget()` return Promises.
Without a vault, all three reject with a plain `Error` (PHP: `LogicException`) whose message names the TS interface: "No vault configured. Pass a Vault to PiiShield to restore across requests." (PHP: "… Pass a VaultInterface …").

## Vault TTLs must be integers

PHP's `int $ttl` type rejects fractions; the port checks at run time and throws a `TypeError` for a non-integer or `NaN` TTL. A TTL ≤ 0 throws a `RangeError` with PHP's message ("The TTL must be positive." / "The vault TTL must be positive."); PHP throws `InvalidArgumentException`. The key length check throws a `RangeError` with PHP's message.

## Lone surrogates in vault mappings

A JavaScript string can contain lone surrogates (see above); `EncryptedVault` writes them as `\u` escapes and reads them back. PHP never writes them, and its `json_decode()` rejects them, so PHP reports such an entry as "Vault entry is corrupt.". Payloads of well-formed text are byte-identical to PHP's.

## TypeLabelMask accepts only a subset of sprintf()

PHP's `TypeLabelMask` passes its format to `sprintf()`. The port supports `%s` (once), `%1$s` and `%%`, which covers every format that renders the type name, and throws a `TypeError` in the constructor for anything else (`%d`, padding, a second `%s`, a trailing `%`), where PHP would render garbage or throw at mask time. A function `(type) => string` can be passed instead of a format.

## Learned types: snapshot instead of a store read per text

PHP's `LearnedTypesDetector` reads the store on every `detect()`. Detection is synchronous here and stores are async, so `EntityLearner` keeps a snapshot: `learn()` and `forget()` update it, `refresh()` reloads it (call it on a timer to see types other processes learned), `EntityLearner.create()` loads it once. `new LearnedTypesDetector(types | () => types)` works without a learner.

## Learned patterns: backtracking budget

Learned patterns run on the port's own matcher with PHP's budget of 100000 per start position, calibrated against PCRE2's JIT. PCRE2's start-up optimisations (required character, first character) are not reproduced, so for patterns close to the limit "it takes too long on adversarial input" can be decided differently; every case in `fixtures/learning.json` → `budget` agrees. On top, one `detect()` call may spend at most 1000000 + 50 × text length steps in total; PHP has no such limit and can run quadratic (e.g. `\s+\d` on a long run of spaces). When a budget runs out, detection throws `PiiShieldError` with code `DETECTION_BACKTRACK_LIMIT` (PHP: `RuntimeException` "Regex failed: Backtrack limit exhausted", same message).

## Learned patterns outside the grammar: which message

PHP checks whether PCRE compiles a pattern before it checks the grammar. For patterns outside the grammar the port cannot ask PCRE; it recognises the common compile errors (unbalanced parentheses, nothing to repeat, unclosed class, trailing backslash, unescaped `~`, `x{3,2}`, invalid ranges) and otherwise assumes the pattern compiles. Such a pattern is rejected either way, but rarely with "is not a valid regular expression" where PHP says "is not allowed: …" or vice versa.

## Key-value store format and locking

`KeyValueCustomEntityStore` (PHP: `CacheCustomEntityStore` over PSR-6) stores the list as JSON under `pii_shield.learned_types`, not in PHP's PSR-6 serialisation, so PHP and Node cannot share that key. `JsonFileCustomEntityStore` locks writes by default with a lock file (`<path>.lock`, exclusive create, stale after 10 s); PHP's file store does not lock unless wrapped in `LockingCustomEntityStore` (symfony/lock), and the two locks do not exclude each other. The file itself is byte-identical.

## The bounded-time check of learned patterns has an overall budget

PHP's `runsInBoundedTime()` limits each start position (`pcre.backtrack_limit`), so checking one pattern can take many seconds (e.g. 16 s for `.{0,45}.{0,45}.{0,45}X`). A PHP worker survives that; in Node it blocks the event loop and with it every request of an HTTP or MCP server. The port shares one budget of 10 million steps across all adversarial inputs (about 0.3 s at most). Patterns that need more are rejected with PHP's message "it takes too long on adversarial input", including some PHP accepts, mostly broad unbounded runs before literals (`\S+@x\.at` with several examples). The bounded form (`\S{1,64}@x\.at`) is accepted.

## PostgreSQL stores and conformance suites (Node only)

PHP has only PSR-6 cache and file stores. The port adds `PostgresVaultStorage` and `PostgresCustomEntityStore` (`@waswrongassembled/pii-shield/postgres`). They take a driver-agnostic `query(text, params)` function, never run DDL (`postgresSchema()` returns it) and work inside the caller's transaction. Vault expiry uses the database clock, and `purgeExpired()` deletes expired rows. Learned types are stored one row per type in `jsonb`, so concurrent writes of different names never conflict. PHP cannot read these tables. The service supports them with `PII_SERVICE_VAULT_STORE=postgres`, `PII_SERVICE_LEARNED_STORE=postgres` and `PII_SERVICE_DATABASE_URL`, and prints the DDL with `pii-shield db-schema`. `@waswrongassembled/pii-shield/testing` (`verifyVaultStorage()`, `verifyCustomEntityStore()`) checks any store against the contracts in [stores.md](stores.md).

## Learned types without examples (Node only)

PHP always stores examples and counter-examples, and its `CustomEntityType` requires at least one example. `EntityLearner` takes `keepExamples: false` (service: `PII_SERVICE_LEARNED_KEEP_EXAMPLES=false`) to store only name, description and pattern, and `dropExamples()` strips types stored before; `withoutExamples(type)` does it for one type. Types without a pattern are refused (`LearningError`) or keep their examples, since only the examples let the model find them. `customEntityTypeFromJSON()` and with it every store reads a type with a pattern and no examples, where PHP's `fromArray()` throws "At least one example is needed.": PHP cannot read a file that holds such a type. `defineCustomEntityType()` still requires an example, as in PHP. With the default `keepExamples: true`, behaviour and file format are unchanged.

## Learned types as a PiiShield option (Node only)

`new PiiShield({ learner })` (also `PiiMasker`, `EntityExtractor`) adds `learner.detector()` after the default or given detectors, unless it is already among them; `detector()` returns the same instance on every call. PHP's Symfony bundle registers the learned-types detector after the built-in ones, in the same order.

## Model-based detection is async

PHP's `ModelDetector` is a synchronous `DetectorInterface`. Model calls are async in Node, so `ModelDetector` is an `AsyncDetector` (`async: true`, `detect(text, { signal })` returns a Promise). `EntityExtractor.extractAsync()`, `PiiShield.redactAsync()`, `PiiShield.redactToVault()` and `PiiMasker.maskAsync()` run it next to the synchronous detectors (same results for the same findings); `extract()`, `redact()` and `mask()` throw a `TypeError` when an async detector is configured, before anything is sent. `redactToVault()` uses the async extraction for every detector set.

## Model detector: model, location and errors

- Instead of a Symfony AI platform, a model name and platform options, `model` is a function `({ system, user }, { signal }) => Promise<string>` or `{ name, generate }`; `detectionModel()` in `@waswrongassembled/pii-shield/ai-sdk` wraps an AI SDK `LanguageModel` (with `generateText()` settings such as `temperature`). Error messages name `name`, else the function's name, else "model".
- "could not be reached (…)" names the JavaScript error's `name` (`Error`, `TypeError`, `TimeoutError`) where PHP names the exception class (`RuntimeException`). A model function that resolves to a non-string fails the same way (`TypeError`).
- Constructor errors are a `RangeError` (chunk size) or `TypeError` (empty name, unknown location, external without acknowledgement) with PHP's messages; the acknowledgement message names the option `acknowledgeExternalTransfer` without PHP's `$`. Only the boolean `true` acknowledges.
- New: `timeout` (milliseconds for a whole `detect()`, then `DETECTION_MODEL_UNREACHABLE`) and `AbortSignal`. When the caller aborts, the Promise rejects with the signal's reason, not a `DetectionError`. When one call of a batch fails, the other calls of the batch are aborted.
- `DetectionError.modelAnswer` (PHP: `DetectionFailedException::$modelAnswer`) is not enumerable, so logging the error does not print the answer.
- Learned types: a `CustomEntityStore` is read at every `detect()` (as in PHP), an `EntityLearner` gives its snapshot (see "Learned types: snapshot"), a plain list is used in its own order (stores sort by name).

## Model answers: values are trimmed by character

The port trims like clarifile PR #95 (`/^[\s\0"'„“”‚‘’«»]+|[\s\0"'„“”‚‘’«»]+$/u`: Unicode whitespace, NUL and the quotes, by character); this section applies to PHP releases before it. PHP cleans a value with `trim($value, " …\"'„“”‚‘’«»")`, which trims _bytes_: a value whose last byte is one of the quotes' bytes (`ř`, `ę`, Cyrillic `р`, `À`, …) or whose first byte is `E2` or `C2` (`€`, …) is cut inside a character, the following `preg_replace()` fails on the invalid UTF-8, and the value is dropped. "Jan Kovář", "Александр" and "€12" are therefore never redacted by PHP's model detector. The port trims the characters, so it finds them (cases "… (byte trim)" in `fixtures/model.json`, which hold the old PHP result). It also trims Unicode whitespace such as a no-break space, which old PHP keeps. Other values give the same result.

## Model answers: JSON parsing

`JSON.parse()` accepts escaped lone surrogates (`"\ud800"`) and nesting deeper than 512 levels, where PHP's `json_decode()` returns null and the answer counts as unusable. When `entities` is a JSON object instead of a list, its integer-like keys come first in JavaScript (PHP keeps the written order); the findings are the same, only equal-offset ties may be ordered differently before overlap resolution.

## Citation and file number checks of model findings

PHP decides whether a finding follows a legal citation with a regex that can backtrack exponentially (" Ziff Ziff Ziff …": `Ziff` is a keyword or `Z` + `iff`); on such a line PHP hits `pcre.backtrack_limit`, `preg_match()` returns false and the finding is redacted. The port decides the same pattern in linear time (differential test against PHP's pattern in `test/redos.test.ts`), so on such adversarial lines it keeps a law abbreviation that follows a real citation. The file number keyword check (`[ \t]*:?[ \t]*$`, quadratic in PHP) and the removal of `<think>` blocks (quadratic for many unclosed ones) are linear too, with PHP's results.

## AI SDK middleware instead of the Symfony AI processor

`piiShieldMiddleware()` (`@waswrongassembled/pii-shield/ai-sdk`) replaces `PiiShieldProcessor` and `StructuredRestorer`. Same core: all texts of a call are joined with PHP's separator (`"\n"` + three U+2063 + `"\n"`) and redacted in one pass, so a value gets the same placeholder in every message. PHP throws a `LogicException` when a text contains the separator; the port adds U+2063 marks until the separator is not in the texts. "Redaction changed the message structure." (plain `Error`) is left for a detector whose result changes the structure. Differences:

- **Every model call is redacted**, including each step of a tool loop. PHP redacts once per `Agent::call()`, so tool results of later rounds reach the provider unredacted (documented limit there).
- **More of the prompt is redacted:** besides text (system, user, assistant, tool results), the middleware redacts reasoning, tool call inputs and JSON tool outputs (string values, not keys), error outputs and approval/denial reasons, because the answer's reasoning and tool inputs are restored and come back in the next call's history. Reasoning parts are sent changed; a provider that signs its reasoning (e.g. Anthropic's thinking signatures) may reject the altered text.
- **Files:** a file in a user message or in a tool result (also a provider-executed one in an assistant message) throws `UnsupportedContentError` (code `UNSUPPORTED_CONTENT`, PHP: `UnsupportedContentException`) before anything is sent; the message names the part type `"file"` instead of a PHP class. Files and custom parts the model itself produced pass unchanged.
- **Tool calls are restored:** tools get the original values (PHP: tools receive placeholders). Tool call inputs are parsed as JSON and string keys and values are restored (other values stay; PHP's `StructuredRestorer` keeps keys); a changed input is re-serialized compactly, an unparsable one is restored textually with JSON-escaped values. Provider-executed tool results are restored the same way.
- **Structured output** (JSON mode) is restored in the JSON text with JSON-escaped values (PHP restores the decoded object), so the AI SDK parses it as usual; placeholders in object keys are restored too.
- **Streams are restored** (PHP passes streamed results through unrestored): text, reasoning and tool input deltas. A possible placeholder at a chunk end is held back until it is complete or impossible, so the streamed text equals the restored whole text. A candidate is given up after 1024 UTF-16 units and emitted unrestored (a whole-text restore would still replace it if it closed later).
- **Unknown placeholders** go to the `onRestore` callback (once per call; for a stream when it ends) instead of the result metadata `pii_shield.unknown_placeholders`; `providerMetadata` is left untouched. New: `onRedact` reports the placeholders and, with `vault: true` (uses `redactToVault()`), the vault id.
- A call whose prompt contains no text is passed through without restoring (PHP: an output without a processed input is left alone).

## JSON keys are redacted, opaque assistant parts are rejected

The middleware redacts and restores object keys in tool call inputs and JSON tool outputs too, not only string values (PHP's `StructuredRestorer` keeps keys): a key like `{"Maria Musterfrau": 3}` would otherwise reach the provider. If two keys of one object map to the same key, the call is rejected with `UnsupportedContentError`.

File, reasoning-file and custom parts of assistant messages cannot be redacted. PHP passes non-text assistant content through; the middleware rejects them (fail closed), including part types of later AI SDK versions it does not know. `allowOpaqueAssistantParts: true` passes them through for histories whose files come from the model itself.

## HTTP service and MCP server

Same endpoints, JSON shapes, status codes and messages as PHP's `ServiceApi`, `RequestGuard` and `PiiShieldTools` (`docs/openapi.yaml`, contract test). Differences:

- **No demo page and no `/api`:** the Node server serves `/v1` and `/mcp` only, so it always behaves like PHP's service mode for other paths (404 `{"error":"Not found."}`). Trusting local peers without a token is still the default; `PII_SERVICE_ONLY=1` (or `requireToken`) turns it off as in PHP.
- **Body size limit (new):** a request body over 2 MiB (`PII_SERVICE_MAX_BODY_BYTES`) gets 413 `{"error":"The request body is too large."}`. PHP reads any size.
- **Unexpected errors** (not a pii-shield error) answer 500 `{"error":"Internal server error."}`; PHP lets Symfony render its error page. Learning store errors are 500 "Detection failed." as in PHP.
- **Response JSON** is `JSON.stringify()`: Symfony's `JsonResponse` also escapes `<`, `>`, `&`, `'` and `"` inside strings as `\u003C` etc. Same JSON values.
- **Model configuration errors** (unknown provider, missing key or URL, external provider without `PII_SERVICE_ACKNOWLEDGE_EXTERNAL=true`) stop the CLI at start with a message naming the variable. PHP builds the model per request and answers 400 (missing key) or 500. `PII_DEMO_GENERIC_KEY` also works as `PII_SERVICE_MODEL_KEY`.
- **Stores:** the vault is in memory (default), Redis or PostgreSQL (`PII_SERVICE_VAULT_STORE`, key from `PII_SERVICE_VAULT_KEY`); PHP's filesystem and SQLite pools and its key file in `var/` do not exist. Learned types are in memory unless `PII_SERVICE_LEARNED_TYPES` names a JSON file (PHP default: `demo/var/learned-types.json`), in Redis via `KeyValueCustomEntityStore` (not shareable with PHP's PSR-6 key, see above), or in PostgreSQL (see above).
- **Learned types are re-read** from the store before every detection request (the learner's snapshot is refreshed), so types learned by other processes apply as in PHP.
- **Local peers:** `PII_LOCAL_PEERS` and the Docker gateway are read once at start (PHP: per request). IPv4-mapped IPv6 peers (`::ffff:127.0.0.1`) count as their IPv4 address.
- **MCP:** argument validation is the port's own for the tools' schemas: the first violation with the wording of PHP's validator for required, type, enum, pattern and item type. Sessions are kept in memory (idle 1 hour, at most 1000, least recently used closed first); PHP stores them in files. Answers are JSON, not SSE. `serverInfo` and `instructions` are PHP's.
- **Model providers** of the CLI call the providers' HTTP APIs with `fetch` (Ollama `/api/chat`, OpenAI-compatible `/v1/chat/completions`, Anthropic `/v1/messages`) with PHP's options (temperature 0 and no reasoning with 1024 answer tokens for self-hosted models, no redirects, 170 s timeout via `PII_SERVICE_MODEL_TIMEOUT`); PHP uses the Symfony AI bridges. Anthropic gets `max_tokens: 4096`.

## PHP bugs deliberately reproduced (PHP fix pending)

Correctness bugs without privacy impact: the port keeps PHP's behaviour so the fixtures match, and follows PHP once it is fixed there. Numbers refer to [UPSTREAM.md](UPSTREAM.md).

- **#3 Letterhead lines split at byte 0x85.** PHP's `AuthorityContext` matches the letterhead without `/u`, so `\R` also ends a line inside "Å", "ą" etc., and it cuts the head at a byte limit. The authority is then not recognised and its contacts are redacted (over-redaction). The port reproduces it on UTF-8 bytes.
- **#10 Chunk limit off by one.** A text of exactly `MAX_CHUNKS × size` characters passes the pre-check and then fails with "at least 51 chunks". Fails closed either way.
- **#12 `$` without `D`.** A single trailing `"\n"` is accepted by the tax ID validator, the learned type name check and the pattern grammar's quantifier check.
- **#13 Placeholder parsing.** A no-break space, NEL or U+2028 inside a type name, non-ASCII digits and leading zeros give unknown placeholders; `⟦⟦PERSON_1⟧⟧` restores to `⟦Maria Musterfrau⟧`.
- **#14 `learnPattern()`** escapes `= ! < > :`, which the pattern grammar rejects: learning from "AB:12" fails.
- **#15 `surname()`** trims ASCII whitespace only and splits at Unicode whitespace: `"Maria Musterfrau\u{A0}"` (a trailing no-break space) yields `""`.
- **#16 Integer-like keys.** A vault mapping with a key such as `"1"` is reported as corrupt (PHP's `json_decode()` turns it into an int).
- **#17 Empty matches.** Patterns that match the empty string (`x{0}`, `|a`) and empty examples are accepted by learning.
- **#18 Service API.** The `types` filter drops learned types unless `OTHER` is listed (openapi.yaml says they always apply); learning store failures answer 500 "Detection failed."; a JSON object is accepted where a list of strings is expected.
- **#19 MCP tools** lack options of the HTTP API (`redact_text`: `types`, `allowlist`, `keepAuthorityContacts`; `learn_entity_type`: `pattern`).
- **#21 Byte windows.** The authority context windows and the letterhead limit count UTF-8 bytes, so non-ASCII text gets a smaller window.
