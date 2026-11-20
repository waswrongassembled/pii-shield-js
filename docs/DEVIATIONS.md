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
