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
- **String functions:** offsets are UTF-16, but length limits and masking that PHP counts with `mb_*` (e.g. `MAX_EXAMPLE_LENGTH`, `PartialMask`) must count code points (`[...s]`) to reject and mask exactly what PHP does. `strtoupper` is ASCII-only in PHP; `toUpperCase()` is not, so for type names use an ASCII-only helper.
- **Checksums:** use integer arithmetic for the IBAN mod 97 (BigInt or chunked), SVNR and tax ID.
- **Secrets:** wipe buffers after use (`buf.fill(0)`) instead of `sodium_memzero`. Keep the key out of logs and errors.
- **Error messages:** never contain PII values (PHP names positions, not values). Keep the wording of client-facing messages (see "Idiomatic TypeScript").

## Phases (each phase: tests green, lint green, own PR)

0. **Scaffold** (done): repo, tsconfig, tsc build, vitest, eslint, CI (GitHub Actions on Node 22/24/26), LICENSE, README skeleton. Write `compat/export-fixtures.php` and generate fixtures.
1. **Validators** (done): `AtSvnrValidator`, `IbanValidator`, `DeTaxIdValidator`.
2. **Detectors** (done):
   - `RegexMatcher`, `AuthorityContext`;
   - Email, Phone, Iban, AtSvnr, TaxNumber, FileNumber, BirthDate, LicensePlate, PostalAddress, SalutationPerson.
3. **Extraction** (done): `Entity`, `EntityType`, `EntityExtractor` (overlaps, word boundaries, priority). `TextSpans` moves to phase 4 (with UTF-16 offsets it is a plain slice loop).
4. **Redaction:** `Placeholder`, `RedactionResult`, `RestoreResult`, `PiiShield.redact/restore`, `NullPiiShield`.
5. **Masking:** `PiiMasker`, `TypeLabelMask`, `PartialMask`.
6. **Vault:**
   - `InMemoryVault`, `EncryptedVault`, storage interface, Redis adapter;
   - `restoreFromVault`, `forget`, TTL;
   - compat test against PHP payloads.
7. **Learning:**
   - `CustomEntityType`, `PatternGrammar`, `PatternLearner`, `EntityLearner` (learn/preview/forget/types);
   - stores: JSON file (with file locking), in-memory, and a cache store via a small KV interface;
   - `LearnedTypesDetector`, `CustomEntityDetector`.
8. **Model detector:** port of `ModelDetector` + `ModelLocation`.
   - Provider-agnostic via an injected function `(prompt) => Promise<string>`, or an AI SDK `LanguageModel`.
   - Same prompt, same JSON parsing.
   - Same guard: an external provider only with explicit `acknowledgeExternalProvider: true` (ADR 0006).
9. **AI SDK middleware** (replaces `PiiShieldProcessor` + `StructuredRestorer`):
   - `wrapLanguageModel({ middleware: piiShieldMiddleware(shield) })`;
   - redacts the prompt, restores text, stream deltas (placeholders that span chunk boundaries) and structured output.
10. **MCP server:** same tools as `demo/src/Mcp/PiiShieldTools.php`: `redact_text`, `restore_text`, `mask_text`, `learn_entity_type`, `list_entity_types`. STDIO + Streamable HTTP.
11. **HTTP service:** same endpoints as `docs/openapi.yaml` (`/v1/...`), plain `node:http` or Hono; `npx @waswrongassembled/pii-shield serve`.
12. **Release:**
    - README (quick start, interop, offsets, limits) and CHANGELOG;
    - `npm publish --provenance` via GitHub Actions (trusted publishing);
    - version 0.1.0.

## Way of working

- Its own Claude session in this repo. Work phase by phase, one subagent per phase with this plan + the matching PHP files as its brief.
- Per phase: port the PHP tests first, then the code (TDD); fixtures must be green.
- Never send PII to an LLM provider; tests run offline. The model detector is tested with a fake.
