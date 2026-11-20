# Deviations from the PHP package

Behaviour that intentionally differs from `clarifile/pii-shield`. A fixture mismatch that is not listed here is a bug.
Pure API shape (options objects, Promises, error classes) is not listed; see "Idiomatic TypeScript" in [PLAN.md](PLAN.md).

## Entity offsets are UTF-16 indices

PHP reports `Entity.offset` in code points (`mb_*`). Node reports UTF-16 indices, so `text.slice(offset, offset + value.length)` returns the value. The two differ only when characters outside the BMP (e.g. emoji) precede the entity. Offsets are not part of any wire format.

## Lone surrogates instead of invalid UTF-8

PHP's regex functions fail on invalid UTF-8 (the detectors then throw). A JavaScript string is never invalid UTF-8, but it can contain lone surrogates; the port treats them as ordinary characters and does not throw.

## Unicode version of character properties

`\p{L}`, `\p{Lu}`, `\p{Nd}` and the other classes follow the Unicode version of the runtime (Node 24: Unicode 17), PHP's follow PCRE2's. Results only differ for characters assigned in between.

## Phone detection does not fail on long digit runs

PHP's phone pattern backtracks catastrophically on a long digit run followed by a letter (e.g. 160 digits and "a"): `preg_match_all` hits `pcre.backtrack_limit` and the whole redaction throws. The port uses an equivalent pattern without the blow-up (each digit group must end where its digit run ends), so it returns the same matches PHP finds on normal input and keeps working on such input. `test/redos.test.ts` checks the equivalence on random texts and bounds the run time of every detector.

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

PHP cleans a value with `trim($value, " …\"'„“”‚‘’«»")`, which trims _bytes_: a value whose last byte is one of the quotes' bytes (`ř`, `ę`, Cyrillic `р`, `À`, …) or whose first byte is `E2` or `C2` (`€`, …) is cut inside a character, the following `preg_replace()` fails on the invalid UTF-8, and the value is dropped. "Jan Kovář", "Александр" and "€12" are therefore never redacted by PHP's model detector. The port trims the characters, so it finds them (cases "… (byte trim)" in `fixtures/model.json`). Values that do not end or start with such a character give the same result.

## Model answers: JSON parsing

`JSON.parse()` accepts escaped lone surrogates (`"\ud800"`) and nesting deeper than 512 levels, where PHP's `json_decode()` returns null and the answer counts as unusable. When `entities` is a JSON object instead of a list, its integer-like keys come first in JavaScript (PHP keeps the written order); the findings are the same, only equal-offset ties may be ordered differently before overlap resolution.

## Citation and file number checks of model findings

PHP decides whether a finding follows a legal citation with a regex that can backtrack exponentially (" Ziff Ziff Ziff …": `Ziff` is a keyword or `Z` + `iff`); on such a line PHP hits `pcre.backtrack_limit`, `preg_match()` returns false and the finding is redacted. The port decides the same pattern in linear time (differential test against PHP's pattern in `test/redos.test.ts`), so on such adversarial lines it keeps a law abbreviation that follows a real citation. The file number keyword check (`[ \t]*:?[ \t]*$`, quadratic in PHP) and the removal of `<think>` blocks (quadratic for many unclosed ones) are linear too, with PHP's results.

## AI SDK middleware instead of the Symfony AI processor

`piiShieldMiddleware()` (`@waswrongassembled/pii-shield/ai-sdk`) replaces `PiiShieldProcessor` and `StructuredRestorer`. Same core: all texts of a call are joined with PHP's separator (`"\n"` + three U+2063 + `"\n"`) and redacted in one pass, so a value gets the same placeholder in every message; a text that contains the separator fails with "Redaction changed the message structure." (plain `Error`, PHP: `LogicException`). Differences:

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
- **Stores:** the vault is in memory (default) or Redis (`PII_SERVICE_VAULT_STORE`, key from `PII_SERVICE_VAULT_KEY`); PHP's filesystem and SQLite pools and its key file in `var/` do not exist. Learned types are in memory unless `PII_SERVICE_LEARNED_TYPES` names a JSON file (PHP default: `demo/var/learned-types.json`), or in Redis via `KeyValueCustomEntityStore` (not shareable with PHP's PSR-6 key, see above).
- **Learned types are re-read** from the store before every detection request (the learner's snapshot is refreshed), so types learned by other processes apply as in PHP.
- **Local peers:** `PII_LOCAL_PEERS` and the Docker gateway are read once at start (PHP: per request). IPv4-mapped IPv6 peers (`::ffff:127.0.0.1`) count as their IPv4 address.
- **MCP:** argument validation is the port's own for the tools' schemas: the first violation with the wording of PHP's validator for required, type, enum, pattern and item type. Sessions are kept in memory (idle 1 hour, at most 1000, least recently used closed first); PHP stores them in files. Answers are JSON, not SSE. `serverInfo` and `instructions` are PHP's.
- **Model providers** of the CLI call the providers' HTTP APIs with `fetch` (Ollama `/api/chat`, OpenAI-compatible `/v1/chat/completions`, Anthropic `/v1/messages`) with PHP's options (temperature 0 and no reasoning with 1024 answer tokens for self-hosted models, no redirects, 170 s timeout via `PII_SERVICE_MODEL_TIMEOUT`); PHP uses the Symfony AI bridges. Anthropic gets `max_tokens: 4096`.
