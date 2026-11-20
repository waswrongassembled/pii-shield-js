import { describe, expect, it } from 'vitest';

import { EntityType, formatPlaceholder, replacePlaceholders } from '../src/index.js';
import { loadFixture } from './support/fixtures.js';

const found = (text: string): { canonical: string; original: string }[] => {
  const result: { canonical: string; original: string }[] = [];
  replacePlaceholders(text, (canonical, original) => {
    result.push({ canonical, original });

    return original;
  });

  return result;
};

describe('formatPlaceholder', () => {
  it.each([
    [EntityType.Person, 1, '⟦PERSON_1⟧'],
    [EntityType.TaxNumber, 12, '⟦TAX_NUMBER_12⟧'],
    ['VN2_NUMBER_3', 1, '⟦VN2_NUMBER_3_1⟧'],
  ])('%s %i → %s', (type, n, expected) => {
    expect(formatPlaceholder(type, n)).toBe(expected);
  });
});

describe('replacePlaceholders', () => {
  it('passes canonical and original form and replaces with the return value', () => {
    expect(replacePlaceholders('A [[tax number 2]] B', (canonical) => `<${canonical}>`)).toBe('A <⟦TAX_NUMBER_2⟧> B');
  });

  it('leaves text without placeholders untouched', () => {
    expect(replacePlaceholders('Keine ⟦ Platzhalter ]]', () => 'x')).toBe('Keine ⟦ Platzhalter ]]');
  });

  // PHP throws here (PCRE JIT stack limit); JavaScript has no such limit, see docs/DEVIATIONS.md.
  it('does not fail on input that exhausts the PCRE JIT stack in PHP', () => {
    const text = `Text davor. [[A${' 1'.repeat(50_000)}`;

    expect(replacePlaceholders(text, () => 'x')).toBe(text);
  });
});

describe('PHP parity (fixtures/redaction.json restore.cases)', () => {
  it.each(loadFixture('redaction').restore.cases)('$case', ({ text, placeholders }) => {
    expect(found(text)).toEqual(placeholders);
  });
});
