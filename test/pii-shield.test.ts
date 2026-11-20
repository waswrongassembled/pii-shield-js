import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  createEntity,
  type Entity,
  EntityType,
  foundTypes,
  NullPiiShield,
  PiiShield,
  type RedactionResult,
} from '../src/index.js';
import { expectedEntity, loadFixture } from './support/fixtures.js';

const fixed =
  (...entities: Entity[]) =>
  (): Entity[] =>
    entities;

// Ported from tests/PiiShieldTest.php.
describe('PiiShield.redact', () => {
  const shield = new PiiShield();

  it('replaces an entity with a typed placeholder', () => {
    const result = shield.redact('SVNR: 4568 150392');

    expect(result.redactedText).toBe('SVNR: ⟦SVNR_1⟧');
    expect(result.mapping).toEqual({ '⟦SVNR_1⟧': '4568 150392' });
  });

  it('leaves text without PII unchanged', () => {
    const text = 'Der Betrag von 110,00 Euro ist am 15.11.2026 fällig (§ 49 VStG).';

    const result = shield.redact(text);

    expect(result.redactedText).toBe(text);
    expect(result.mapping).toEqual({});
    expect(result.entities).toEqual([]);
  });

  it.each([
    [
      'numbers placeholders per type in order of appearance',
      'IBAN DE89 3704 0044 0532 0130 00 und AT61 1904 3002 3457 3201, SVNR 4568 150392',
      'IBAN ⟦IBAN_1⟧ und ⟦IBAN_2⟧, SVNR ⟦SVNR_1⟧',
    ],
    [
      'same value gets the same placeholder',
      'Zahl: BHMS-VK-2026/48213. Verwendungszweck: BHMS-VK-2026/48213',
      'Zahl: ⟦FILE_NUMBER_1⟧. Verwendungszweck: ⟦FILE_NUMBER_1⟧',
    ],
    [
      'further occurrences of a detected value are redacted',
      'Zahl: BHMS-VK-2026/48213\nBitte BHMS-VK-2026/48213 angeben.',
      'Zahl: ⟦FILE_NUMBER_1⟧\nBitte ⟦FILE_NUMBER_1⟧ angeben.',
    ],
    [
      'value inside a longer word is not redacted',
      'Sehr geehrter Herr Beispiel, siehe Beispielrechnung.',
      'Sehr geehrter Herr ⟦PERSON_1⟧, siehe Beispielrechnung.',
    ],
    [
      'surname of a full name from the address block is propagated',
      'Frau\nMaria Musterfrau\n\nMusterfrau wurde verständigt.',
      'Frau\n⟦PERSON_1⟧\n\n⟦PERSON_1⟧ wurde verständigt.',
    ],
    [
      'OCR address block, fixture 01',
      'Zahl: BHMS-VK-2026/48213\n\nFrau\n\nMaria Musterfrau\nLindenweg 12\n6900 Bregenz\n\nSehr geehrte Frau Musterfrau,',
      'Zahl: ⟦FILE_NUMBER_1⟧\n\nFrau\n\n⟦PERSON_1⟧\n⟦ADDRESS_1⟧\n\nSehr geehrte Frau ⟦PERSON_1⟧,',
    ],
    [
      'OCR address block, fixture 02',
      'Herrn\n\nJ ohann Beispielmann\n\nBahnhofstraße 7/3\n\n4020 Linz\n\nSehr geehrter Herr Beispielmann,',
      'Herrn\n\n⟦PERSON_1⟧\n\n⟦ADDRESS_1⟧\n\nSehr geehrter Herr ⟦PERSON_1⟧,',
    ],
    [
      'surname of an uncertain inline name is not propagated',
      'Wir haben Herrn Muster Bescheid gegeben. Der Bescheid ist rechtskräftig.',
      'Wir haben Herrn ⟦PERSON_1⟧ gegeben. Der Bescheid ist rechtskräftig.',
    ],
  ])('%s', (_, text, expected) => {
    expect(shield.redact(text).redactedText).toBe(expected);
  });

  it('counts the same value once', () => {
    expect(
      Object.keys(shield.redact('Zahl: BHMS-VK-2026/48213. Verwendungszweck: BHMS-VK-2026/48213').mapping),
    ).toHaveLength(1);
  });

  it('maps a surname alone to the same person placeholder', () => {
    const result = shield.redact(
      'Herrn\nJohann Beispielmann\n\nSehr geehrter Herr Beispielmann, Beispielmann hat bezahlt.',
    );

    expect(result.redactedText).toBe('Herrn\n⟦PERSON_1⟧\n\nSehr geehrter Herr ⟦PERSON_1⟧, ⟦PERSON_1⟧ hat bezahlt.');
    expect(result.mapping).toEqual({ '⟦PERSON_1⟧': 'Johann Beispielmann' });
  });

  it.each([
    [
      ['AT61 1904 3002 3457 3201'],
      'IBAN AT61 1904 3002 3457 3201, SVNR 4568 150392',
      'IBAN AT61 1904 3002 3457 3201, SVNR ⟦SVNR_1⟧',
    ],
    [
      ['Musterfrau'],
      'Frau\nMaria Musterfrau\n\nMusterfrau wurde verständigt.',
      'Frau\n⟦PERSON_1⟧\n\nMusterfrau wurde verständigt.',
    ],
  ])('never redacts allowlisted values %j', (allowlist, text, expected) => {
    expect(new PiiShield({ allowlist }).redact(text).redactedText).toBe(expected);
  });

  it('lets the longer overlapping entity win', () => {
    const short = createEntity({
      type: EntityType.Phone,
      value: '0044 0532 0130',
      offset: 15,
      confidence: 0.8,
      detector: 'phone',
    });
    const long = createEntity({
      type: EntityType.Iban,
      value: 'DE89 3704 0044 0532 0130 00',
      offset: 5,
      detector: 'iban',
    });
    const custom = new PiiShield({ detectors: [fixed(short), fixed(long)] });

    expect(custom.redact('IBAN DE89 3704 0044 0532 0130 00').redactedText).toBe('IBAN ⟦IBAN_1⟧');
  });

  it('lets the higher confidence win on equal length', () => {
    const weak = createEntity({
      type: EntityType.FileNumber,
      value: '12345678',
      offset: 4,
      confidence: 0.5,
      detector: 'weak',
    });
    const strong = createEntity({
      type: EntityType.TaxNumber,
      value: '12345678',
      offset: 4,
      confidence: 0.9,
      detector: 'strong',
    });
    const custom = new PiiShield({ detectors: [fixed(weak), fixed(strong)] });

    expect(custom.redact('Nr. 12345678').redactedText).toBe('Nr. ⟦TAX_NUMBER_1⟧');
  });

  it('sorts entities by offset', () => {
    const result = shield.redact('SVNR 4568 150392, IBAN AT61 1904 3002 3457 3201');

    expect(result.entities.map((e) => e.type)).toEqual([EntityType.AtSvnr, EntityType.Iban]);
    expect(foundTypes(result)).toEqual([EntityType.AtSvnr, EntityType.Iban]);
  });

  it('handles Windows line endings and no-break spaces', () => {
    const text =
      'Frau\r\nMaria Musterfrau\r\nLindenweg 12\r\n6900 Bregenz\r\n\r\nIBAN AT61\u{A0}1904\u{A0}3002\u{A0}3457\u{A0}3201\rSVNR 4568\u{202F}150392';

    const result = shield.redact(text);

    expect(result.redactedText).toBe('Frau\r\n⟦PERSON_1⟧\r\n⟦ADDRESS_1⟧\r\n\r\nIBAN ⟦IBAN_1⟧\rSVNR ⟦SVNR_1⟧');
    expect(result.mapping['⟦ADDRESS_1⟧']).toBe('Lindenweg 12\r\n6900 Bregenz');
    expect(shield.restore(result.redactedText, result).text).toBe(text);
  });

  it('uses learned type names (labels) in placeholders', () => {
    const custom = new PiiShield({
      detectors: [
        fixed(
          createEntity({ type: EntityType.Other, value: 'VN-1', offset: 0, label: 'INSURANCE_NUMBER' }),
          createEntity({ type: EntityType.Other, value: 'X-2', offset: 5 }),
        ),
      ],
    });

    expect(custom.redact('VN-1 X-2').mapping).toEqual({ '⟦INSURANCE_NUMBER_1⟧': 'VN-1', '⟦OTHER_1⟧': 'X-2' });
  });

  it('returns frozen results whose mapping serializes as a plain object', () => {
    const result = shield.redact('SVNR 4568 150392');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.mapping)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      redactedText: 'SVNR ⟦SVNR_1⟧',
      mapping: { '⟦SVNR_1⟧': '4568 150392' },
      entities: [{ type: 'SVNR', value: '4568 150392', offset: 5, confidence: 1, detector: 'at_svnr' }],
    });
    expect({ ...result }.mapping).toBe(result.mapping);
  });

  it('hides original values from util.inspect / console.log (like PHP __debugInfo)', () => {
    const shown = inspect(shield.redact('SVNR 4568 150392'));

    expect(shown).not.toContain('150392');
    expect(shown).toContain('⟦SVNR_1⟧');
    expect(shown).toContain('[hidden]');
  });
});

describe('PiiShield.restore', () => {
  const shield = new PiiShield();

  it('replaces placeholders with the originals', () => {
    const redaction = shield.redact('SVNR 4568 150392, IBAN AT61 1904 3002 3457 3201');

    const restored = shield.restore('Ihre SVNR ⟦SVNR_1⟧ und Ihr Konto ⟦IBAN_1⟧.', redaction);

    expect(restored).toEqual({
      text: 'Ihre SVNR 4568 150392 und Ihr Konto AT61 1904 3002 3457 3201.',
      unknownPlaceholders: [],
      unusedPlaceholders: [],
      isClean: true,
    });
  });

  it.each([
    ['exact', '⟦SVNR_1⟧'],
    ['lowercase', '⟦svnr_1⟧'],
    ['inner whitespace', '⟦ SVNR_1 ⟧'],
    ['space instead of underscore', '⟦SVNR 1⟧'],
    ['markdown-escaped underscore', '⟦SVNR\\_1⟧'],
    ['ascii double brackets', '[[SVNR_1]]'],
    ['multi-word type', '⟦tax number 1⟧'],
  ])('tolerates mangled placeholders: %s', (_, placeholder) => {
    const redaction = shield.redact('SVNR 4568 150392, Steuernummer 46 123/4567');
    const expected = placeholder.toLowerCase().includes('tax') ? '46 123/4567' : '4568 150392';

    const restored = shield.restore(`Wert: **${placeholder}**.`, redaction);

    expect(restored.text).toBe(`Wert: **${expected}**.`);
    expect(restored.isClean).toBe(true);
  });

  it('reports unknown and unused placeholders', () => {
    const redaction = shield.redact('SVNR 4568 150392, IBAN AT61 1904 3002 3457 3201');

    const restored = shield.restore('Herr ⟦PERSON_1⟧ hat die SVNR ⟦SVNR_1⟧.', redaction);

    expect(restored.text).toBe('Herr ⟦PERSON_1⟧ hat die SVNR 4568 150392.');
    expect(restored.isClean).toBe(false);
    expect(restored.unknownPlaceholders).toEqual(['⟦PERSON_1⟧']);
    expect(restored.unusedPlaceholders).toEqual(['⟦IBAN_1⟧']);
  });

  it('accepts a plain mapping, e.g. one loaded from JSON', () => {
    const mapping = JSON.parse('{"⟦SVNR_1⟧":"4568 150392"}') as Record<string, string>;

    expect(shield.restore('SVNR [[svnr 1]]', mapping).text).toBe('SVNR 4568 150392');
  });

  it('ignores inherited properties of the mapping', () => {
    const mapping = Object.create({ '⟦SVNR_1⟧': 'inherited' }) as Record<string, string>;

    expect(shield.restore('⟦SVNR_1⟧ ⟦CONSTRUCTOR_1⟧', mapping)).toEqual({
      text: '⟦SVNR_1⟧ ⟦CONSTRUCTOR_1⟧',
      unknownPlaceholders: ['⟦SVNR_1⟧', '⟦CONSTRUCTOR_1⟧'],
      unusedPlaceholders: [],
      isClean: false,
    });
  });
});

// Ported from tests/NullPiiShieldTest.php.
describe('NullPiiShield', () => {
  it('round trip is identity', () => {
    const shield = new NullPiiShield();
    const text = 'Sehr geehrte Frau Muster, SVNR 1237 010180';

    const redaction = shield.redact(text);

    expect(redaction).toEqual({ redactedText: text, mapping: {}, entities: [] });
    expect(shield.restore(redaction.redactedText, redaction)).toEqual({
      text,
      unknownPlaceholders: [],
      unusedPlaceholders: [],
      isClean: true,
    });
  });
});

const expectRedaction = (
  text: string,
  actual: RedactionResult,
  expected: { redactedText: string; vault: Record<string, string>; entities: Parameters<typeof expectedEntity>[1][] },
): void => {
  expect(actual.redactedText).toBe(expected.redactedText);
  // Same keys, values and insertion order as PHP's JSON.
  expect(Object.entries(actual.mapping)).toEqual(Object.entries(expected.vault));
  expect(actual.entities).toEqual(expected.entities.map((e) => expectedEntity(text, e)));
};

describe('PHP parity (fixtures/redaction.json)', () => {
  const fixture = loadFixture('redaction');
  const shield = new PiiShield();

  it.each(fixture.cases)('$case', ({ text, redaction }) => {
    expectRedaction(text, shield.redact(text), redaction);
  });

  // The custom-type case needs learned types (phase 7).
  it.each(fixture.configured.filter((c) => c.customTypes.length === 0))('configured: $case', (c) => {
    expectRedaction(c.text, new PiiShield({ allowlist: c.allowlist }).redact(c.text), c.redaction);
  });

  it.each(fixture.restore.cases)('restore: $case', (c) => {
    expect(shield.restore(c.text, fixture.restore.vault)).toEqual({
      text: c.restored,
      unknownPlaceholders: c.unknownPlaceholders,
      unusedPlaceholders: c.unusedPlaceholders,
      isClean: c.isClean,
    });
  });
});
