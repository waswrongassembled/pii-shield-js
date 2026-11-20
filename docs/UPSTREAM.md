# Findings for the PHP package

Behaviour of `clarifile/pii-shield` found while porting it, worth fixing upstream. Ordered by impact. Reproductions use synthetic values only.

Status (checked against PHP main, 20.11.2026): confirmed #1, #3, #5, #7, #12, #14. #1 and #5 are fixed in clarifile PR #95; the port uses the same fix. #2 is a known, documented limit. The port fixes privacy and crash bugs and reproduces the others until PHP fixes them; [DEVIATIONS.md](DEVIATIONS.md) lists both groups.

## Privacy: personal data is not redacted or reaches the provider

1. **Model detector drops names with certain characters.** `trim($value, " \t\n\r\0\x0B\"'„“”‚‘’«»")` in `ModelDetector` trims bytes, not characters. Values ending in ř, ę, Cyrillic р and similar, or starting with €, are cut inside a UTF-8 sequence, become invalid and are dropped silently: "Jan Kovář", "Александр" and "€12" are never redacted (verified with PHP 8.5). **Fixed in clarifile PR #95**: `/^[\s\0"'„“”‚‘’«»]+|[\s\0"'„“”‚‘’«»]+$/u`.
2. **Agent tool loops leak tool results.** `PiiShieldProcessor` redacts once per `Agent::call()`; tool results of later rounds reach the provider in clear text. **Known and documented** (pii-shield `docs/library.md`, "Tool results are not redacted"); the Node middleware redacts every model call.
3. **Authority letterhead not recognised** (`AuthorityContext::letterhead()` / `authorityLineOf()`): `\R` without `/u` also splits at byte 0x85, which occurs inside "Å", "ą" etc. Such a letterhead line becomes invalid UTF-8; the authority's own e-mail address is then redacted (over-redaction, but it also disables the authority logic for the whole letter). Related: `substr($head, 0, $limit + 2)` and the 2000-byte head can cut a multibyte character, and the `/mu` match fails.
4. **Unicode digits.** Detectors match them via `\d` under UCP, validators (SVNR, Steuer-ID) and the phone digit count accept ASCII only: an SVNR or tax ID in fullwidth or Arabic-Indic digits is never found. The model detector's file-number check also uses ASCII `\d`.

## Robustness: requests fail or block

5. **Phone detection throws on long digit runs.** `PhoneDetector::PATTERN` (`(?:[ \/-]?\d{2,}){1,5}`) splits a digit run in O(n⁴) ways: a run of about 50 digits or more followed by a letter hits "Backtrack limit exhausted" and the whole `redact()` throws. **Fixed in clarifile PR #95**: `(?:[ \/-]?\d{2,}(?!\d)){1,5}`.
6. **Model detector regexes.** `CITATION_BEFORE` backtracks exponentially ("Ziff" as `Z`+`iff` or a keyword); `[ \t]*:?[ \t]*$` after file-number keywords and the lazy `<think>.*?</think>` with many unclosed blocks are quadratic.
7. **Restore throws on crafted input.** `Placeholder::replaceAll()` throws "JIT stack limit exhausted" for an unclosed `[[A` followed by 5000 ` 1` tokens.
8. **Learned-pattern check costs seconds.** `CustomEntityType::runsInBoundedTime()` limits each start position only: `.{0,45}.{0,45}.{0,45}X` takes about 16 s to validate. `CustomEntityDetector` can also run quadratic (`\s+\d` on a long run of spaces).
9. **The HTTP service has no request body size limit.**
10. **Chunk limit off by one.** A text of exactly `MAX_CHUNKS × size` characters passes the pre-check and then fails with "at least 51 chunks".
11. **Separator in user input.** A user text containing U+2063 three times makes `PiiShieldProcessor` throw a `LogicException`.

## Correctness

12. **`$` without the `D` modifier** accepts a trailing newline: `DeTaxIdValidator` (`"86095742719\n"` is valid), the learned type name regex, the pattern grammar's quantifier check (`x{2\n}`), and the `/v1` path regexes (`%0A`).
13. **Placeholder parsing mixes regex modes.** The tolerant pattern uses `/u`, the separator `preg_replace` does not: a no-break space, NEL or U+2028 inside a type name stays, and the placeholder is unknown. Placeholders with non-ASCII digits (`⟦PERSON_١⟧`) or a leading zero (`⟦PERSON_01⟧`) are found but never known. Nested brackets: `⟦⟦PERSON_1⟧⟧` restores to `⟦Maria Musterfrau⟧`.
14. **`PatternLearner::escape()`** escapes `= ! < > :`, which `PatternGrammar` rejects: learning from "AB:12" fails with "the escape \: is not allowed".
15. **`EntityExtractor::surname()`**: `trim()` strips ASCII whitespace only, the split uses Unicode `\s+`: `"Maria Musterfrau"` followed by a no-break space (U+00A0) yields `""` (with an ASCII space it works).
16. **Integer-like keys.** `json_decode(…, true)` turns keys such as `"1"` into ints: `EncryptedVault::fetch()` reports such a mapping as corrupt, and `PiiShield::assignPlaceholders()` passes an all-numeric Person value as int to `surname(string)` (TypeError under strict_types; only reachable with a custom detector).
17. **Patterns that match the empty string** (`x{0}`, `|a`) and empty examples are accepted by learning.
18. **Service API:** the `types` filter drops learned types unless `OTHER` is listed, although openapi.yaml says "Learned types always apply"; learning-store failures answer 500 "Detection failed."; `ServiceApi::strings()` accepts a JSON object as a list; a missing provider key fails per request instead of at startup; the env name `PII_DEMO_GENERIC_KEY` configures the service.
19. **MCP tools** lack options the HTTP API has: `redact_text` has no `types`, `allowlist` or `keepAuthorityContacts`, `learn_entity_type` no `pattern`.

## Worth checking

20. `EncryptedVault::fetch()` passes the `JsonException` on as `previous`. In Node, `JSON.parse` messages quote the input, i.e. the decrypted mapping, so the port throws a fixed message without a cause; check whether PHP's message can contain plaintext before it reaches a log.
21. Window and letterhead limits count bytes, so non-ASCII letters get a smaller window. Not a bug, but undocumented.
