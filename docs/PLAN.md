# pii-shield for Node.js: port plan

Port of `clarifile/pii-shield` (PHP, MIT, github.com/massiveart/clarifile, `packages/pii-shield`) to TypeScript.
Goal: same behaviour, same wire formats, so PHP and Node can redact and restore each other's data.

Source of truth: the PHP package. Local copy: path in `CLAUDE.local.md` (read-only; never edit it from here).

## Decisions

- **Fully interoperable with PHP:** placeholder format, vault payload and learned-type JSON are byte-compatible.
- **v1 scope:** everything, including the bridges (AI SDK middleware, MCP server, model detector, HTTP service).
- **Publishing:** public repo under the GitHub account `waswrongassembled`, MIT. Keep the original copyright line ("the Clarifile contributors") and add your own. Publish on npmjs.com as `@waswrongassembled/pii-shield` (assumption: npm scope = GitHub name; needs an npm account).
- **Stack:**
  - TypeScript, ESM only, Node >= 20.
  - Build with `tsup`, tests with `vitest`, `eslint` + `prettier`, `tsc --strict`.
  - Core has zero runtime dependencies except `@noble/ciphers` (XChaCha20-Poly1305; Node crypto lacks it).
- **Package layout:** one package with subpath exports; the bridge peer deps are optional.
  - `@waswrongassembled/pii-shield`: core.
  - `.../vault-redis`: Redis storage, peer `ioredis`.
  - `.../ai-sdk`: Vercel AI SDK middleware, peer `ai`.
  - `.../mcp`: MCP server, peer `@modelcontextprotocol/sdk`.
  - `.../server`: HTTP service plus the `pii-shield` CLI binary.

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
4. **Learned types:** the JSON file has the same shape as `JsonFileCustomEntityStore` / `CustomEntityType::toArray()`, with the same limits and validation messages.
5. **Offsets:** PHP reports `Entity.offset` in code points (`mb_*`, see `TextSpans.php`). JS strings count in UTF-16 units, so emoji and other characters outside the BMP count twice. Node keeps the semantics: offset and length are code points as well, for identical results on both sides. The README notes how to convert for `String.prototype.slice`. Internally the regex engine works on UTF-16 indices: convert at the API boundary (preg also gives byte offsets internally; PHP converts them as well).

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
- **PatternGrammar** checks user patterns (safe subset, at most one unbounded quantifier, length limit) and compiles them to PCRE `~(?:…)~u`. In TS they become `new RegExp('(?:…)', 'u')`. The grammar must reject everything that behaves differently in PCRE and JS, so the same pattern means the same thing on both sides. This is a safety and parity risk: test it most thoroughly.
- **String functions:** use `mb_*` → code-point aware (`[...s]`, `Intl.Segmenter` only if PHP uses graphemes). `strtoupper` is ASCII-only in PHP; `toUpperCase()` is not, so for type names use an ASCII-only helper.
- **Checksums:** use integer arithmetic for the IBAN mod 97 (BigInt or chunked), SVNR and tax ID.
- **Secrets:** wipe buffers after use (`buf.fill(0)`) instead of `sodium_memzero`. Keep the key out of logs and errors.
- **Error messages:** never contain PII values (PHP names positions, not values). Take them over 1:1.

## Phases (each phase: tests green, lint green, own PR)

0. **Scaffold:** repo, tsconfig, tsup, vitest, eslint, CI (GitHub Actions on Node 20/22/24), LICENSE, README skeleton. Write `compat/export-fixtures.php` and generate fixtures.
1. **Validators:** `AtSvnrValidator`, `IbanValidator`, `DeTaxIdValidator`.
2. **Detectors:**
   - `RegexMatcher`, `AuthorityContext`;
   - Email, Phone, Iban, AtSvnr, TaxNumber, FileNumber, BirthDate, LicensePlate, PostalAddress, SalutationPerson.
3. **Extraction:** `Entity`, `EntityType`, `TextSpans`, `EntityExtractor` (overlaps, word boundaries, priority).
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
