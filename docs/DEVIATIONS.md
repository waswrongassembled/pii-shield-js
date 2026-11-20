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
