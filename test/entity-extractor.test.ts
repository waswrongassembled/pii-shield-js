import { describe, expect, it } from 'vitest';

import {
  createEntity,
  ENTITY_TYPES,
  type Entity,
  EntityExtractor,
  EntityType,
  isEntityType,
  surname,
  typeName,
} from '../src/index.js';
import { expectedEntity, loadFixture } from './support/fixtures.js';

const values = (entities: Entity[]): string[] => entities.map((e) => e.value);
const fixed =
  (...entities: Entity[]) =>
  (): Entity[] =>
    entities;

describe('EntityType', () => {
  it('has the values of the PHP enum (compatibility contract)', () => {
    expect(ENTITY_TYPES).toEqual(
      'PERSON ADDRESS SVNR IBAN TAX_NUMBER FILE_NUMBER EMAIL PHONE BIRTH_DATE LICENSE_PLATE ID_NUMBER CREDIT_CARD IP_ADDRESS HEALTH OTHER'.split(
        ' ',
      ),
    );
    expect(Object.isFrozen(EntityType)).toBe(true);
    expect(isEntityType('IBAN')).toBe(true);
    expect(isEntityType('iban')).toBe(false);
  });

  it('names an entity by its label, else by its type', () => {
    expect(typeName(createEntity({ type: EntityType.Iban, value: 'x', offset: 0 }))).toBe('IBAN');
    expect(typeName(createEntity({ type: EntityType.Other, value: 'x', offset: 0, label: 'INSURANCE_NUMBER' }))).toBe(
      'INSURANCE_NUMBER',
    );
    expect(createEntity({ type: EntityType.Other, value: 'x', offset: 0, label: null })).toEqual({
      type: 'OTHER',
      value: 'x',
      offset: 0,
      confidence: 1,
      detector: 'unknown',
    });
  });
});

// Ported from tests/EntityExtractorTest.php.
describe('EntityExtractor', () => {
  it('keeps touching spans', () => {
    const extractor = new EntityExtractor({
      detectors: [
        fixed(
          createEntity({ type: EntityType.FileNumber, value: 'AB12', offset: 0, detector: 'test' }),
          createEntity({ type: EntityType.FileNumber, value: 'CD34', offset: 4, detector: 'test' }),
        ),
      ],
    });

    expect(values(extractor.extract('AB12CD34'))).toEqual(['AB12', 'CD34']);
  });

  it('keeps the longer of overlapping spans', () => {
    const extractor = new EntityExtractor({
      detectors: [
        {
          detect: fixed(
            createEntity({ type: EntityType.FileNumber, value: 'AB12', offset: 0, detector: 'test' }),
            createEntity({
              type: EntityType.FileNumber,
              value: '12CD34',
              offset: 2,
              confidence: 0.5,
              detector: 'test',
            }),
          ),
        },
      ],
    });

    expect(values(extractor.extract('AB12CD34'))).toEqual(['12CD34']);
  });

  it('propagates every detected value, not just one per type', () => {
    const text =
      'Frau\nMaria Musterfrau\n\nHerrn\nJohann Beispielmann\n\nMusterfrau und Beispielmann wurden verständigt.';

    expect(values(new EntityExtractor().extract(text))).toEqual([
      'Maria Musterfrau',
      'Johann Beispielmann',
      'Musterfrau',
      'Beispielmann',
    ]);
  });

  it('finds full names again without salutation', () => {
    const text =
      'Frau\nMaria Musterfrau\n\nHerrn\nJohann Beispielmann\n\nGeladen: Maria Musterfrau, Johann Beispielmann.';

    expect(values(new EntityExtractor().extract(text))).toEqual([
      'Maria Musterfrau',
      'Johann Beispielmann',
      'Maria Musterfrau',
      'Johann Beispielmann',
    ]);
  });

  it('treats a value right after an umlaut as part of another word', () => {
    expect(values(new EntityExtractor().extract('Frau\nMaria Musterfrau\nÄMusterfrau'))).toEqual(['Maria Musterfrau']);
  });

  it('reports UTF-16 offsets and original characters after normalization', () => {
    const text = '😀\r\nFrau\r\nMaria\u{A0}Musterfrau\r\nTel. 0664\u{2009}1234567';
    const entities = new EntityExtractor().extract(text);

    expect(values(entities)).toEqual(['Maria\u{A0}Musterfrau', '0664\u{2009}1234567']);
    for (const e of entities) {
      expect(text.slice(e.offset, e.offset + e.value.length)).toBe(e.value);
    }
  });

  it('ranks overlapping spans by code point length, as PHP does', () => {
    // "𝐀𝐁𝐂" is 3 code points but 6 UTF-16 units, "𝐂abc" 4 code points but 5 units: PHP keeps "𝐂abc".
    const extractor = new EntityExtractor({
      detectors: [
        fixed(
          createEntity({ type: EntityType.Other, value: '𝐀𝐁𝐂', offset: 0, detector: 'test' }),
          createEntity({ type: EntityType.Other, value: '𝐂abc', offset: 4, detector: 'test' }),
        ),
      ],
    });

    expect(values(extractor.extract('𝐀𝐁𝐂abc'))).toEqual(['𝐂abc']);
  });
});

describe('surname', () => {
  it.each([
    ['Maria Musterfrau', 'Musterfrau'],
    ['Johann  Beispielmann ', 'Beispielmann'],
    ['Beispielmann', null],
    ['J ohann Beispielmann', 'Beispielmann'],
    // PHP's trim() keeps the no-break space, and preg_split() then yields an empty last part.
    ['Maria Musterfrau\u{A0}', ''],
    // preg_split('/\s+/u') splits at PCRE's Unicode whitespace: U+0085 yes, U+FEFF no.
    ['Maria\u{85}Musterfrau', 'Musterfrau'],
    ['Maria\u{FEFF}Musterfrau', null],
    ['\u{A0}Maria', 'Maria'],
    ['', null],
  ])('%j → %j', (name, expected) => {
    expect(surname(name)).toBe(expected);
  });
});

describe('PHP parity (fixtures/redaction.json)', () => {
  const fixture = loadFixture('redaction');
  const extractor = new EntityExtractor();

  it.each(fixture.cases)('$case', ({ text, redaction }) => {
    expect(extractor.extract(text)).toStrictEqual(redaction.entities.map((e) => expectedEntity(text, e)));
  });

  // Custom types are phase 7.
  it.each(fixture.configured.filter((c) => c.customTypes.length === 0))(
    'configured: $case',
    ({ allowlist, text, redaction }) => {
      expect(new EntityExtractor({ allowlist }).extract(text)).toStrictEqual(
        redaction.entities.map((e) => expectedEntity(text, e)),
      );
    },
  );
});

describe('PHP parity (fixtures/letters.json)', () => {
  it.each(loadFixture('letters').letters)('$name', ({ text, redaction }) => {
    expect(new EntityExtractor().extract(text)).toStrictEqual(redaction.entities.map((e) => expectedEntity(text, e)));
  });
});
