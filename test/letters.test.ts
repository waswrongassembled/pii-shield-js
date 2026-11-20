import { describe, expect, it } from 'vitest';

import { PiiMasker, PiiShield, type RedactionResult } from '../src/index.js';
import { expectedEntity, loadFixture } from './support/fixtures.js';

const shield = new PiiShield();
const masker = new PiiMasker();
const letters = loadFixture('letters').letters;
const detectable = letters.filter((l) => l.expected.detection !== 'model');

/**
 * Ported from FixtureLetterTest::withAliasesExpanded(): an alias is an entity value that is not in the
 * mapping; it restores as the full name ending in it.
 */
function withAliasesExpanded(text: string, redaction: RedactionResult): string {
  const values = Object.values(redaction.mapping);
  let expanded = '';
  let cursor = 0;
  for (const entity of redaction.entities) {
    let restored = entity.value;
    if (!values.includes(entity.value)) {
      const fullNames = values.filter((v) => v.endsWith(` ${entity.value}`));
      expect(fullNames, `alias "${entity.value}" must link to exactly one full name`).toHaveLength(1);
      restored = fullNames[0] ?? '';
    }
    expanded += text.slice(cursor, entity.offset) + restored;
    cursor = entity.offset + entity.value.length;
  }

  return expanded + text.slice(cursor);
}

describe('PHP parity (fixtures/letters.json)', () => {
  it.each(letters)('$name', ({ text, redaction, restored, mask }) => {
    const result = shield.redact(text);

    expect(result.redactedText).toBe(redaction.redactedText);
    expect(Object.entries(result.mapping)).toEqual(Object.entries(redaction.vault));
    expect(result.entities).toEqual(redaction.entities.map((e) => expectedEntity(text, e)));
    expect(shield.restore(result.redactedText, result).text).toBe(restored);
    expect(masker.mask(text)).toBe(mask);
  });
});

// Ported from tests/FixtureLetterTest.php; letters that need model-based detection are skipped there too.
describe.each(detectable)('letter $name', ({ text, expected }) => {
  it('redacts every expected PII span', () => {
    const result = shield.redact(text);

    for (const pii of expected.pii) {
      expect(result.redactedText, `${pii.type} leaked`).not.toContain(pii.value);
      expect(
        result.entities.some((e) => e.type === pii.type && e.value === pii.value),
        `no ${pii.type} entity`,
      ).toBe(true);
    }
  });

  it('keeps must-survive strings', () => {
    const result = shield.redact(text);

    for (const keep of expected.must_survive) {
      expect(result.redactedText).toContain(keep);
    }
  });

  it('does not redact negative samples', () => {
    for (const negative of expected.negative) {
      expect(shield.redact(negative.value).entities, negative.reason).toEqual([]);
    }
  });

  it('restores the original text, with surname aliases expanded', () => {
    const redaction = shield.redact(text);

    const restored = shield.restore(redaction.redactedText, redaction);

    expect(restored.text).toBe(withAliasesExpanded(text, redaction));
    expect(restored.isClean).toBe(true);
    expect(restored.unusedPlaceholders).toEqual([]);
  });

  it('masks PII and keeps must-survive strings', () => {
    const masked = masker.mask(text);

    for (const pii of expected.pii) {
      expect(masked, `${pii.type} leaked`).not.toContain(pii.value);
    }
    for (const keep of expected.must_survive) {
      expect(masked).toContain(keep);
    }
  });
});
