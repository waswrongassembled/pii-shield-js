import { describe, expect, it } from 'vitest';

import {
  createEntity,
  defaultMaskingStrategies,
  type Entity,
  EntityType,
  PartialMask,
  PiiMasker,
  TypeLabelMask,
} from '../src/index.js';
import { loadFixture } from './support/fixtures.js';

const entity = (value: string, type: EntityType = EntityType.Iban): Entity => createEntity({ type, value, offset: 0 });

// Ported from tests/PiiMaskerTest.php.
describe('PiiMasker', () => {
  const masker = new PiiMasker();

  it.each([
    ['IBAN keeps first and last 4', 'IBAN AT61 1904 3002 3457 3201, danke', 'IBAN AT61 **** **** **** 3201, danke'],
    ['phone keeps last 2', 'Mobil: +43 664 1234567', 'Mobil: *** *** *****67'],
    ['person as type label', 'Sehr geehrte Frau Musterfrau,', 'Sehr geehrte Frau [PERSON],'],
    ['SVNR as type label', 'SVNR 4568 150392', 'SVNR [SVNR]'],
    [
      'multi-line address as one label',
      'Frau\nMaria Musterfrau\nLindenweg 12\n6900 Bregenz',
      'Frau\n[PERSON]\n[ADDRESS]',
    ],
    ['no PII unchanged', 'Betrag 110,00 Euro bis 15.11.2026', 'Betrag 110,00 Euro bis 15.11.2026'],
  ])('masks with default strategies: %s', (_, text, expected) => {
    expect(masker.mask(text)).toBe(expected);
  });

  it('does not let no-break spaces hide values', () => {
    const masked = masker.mask('SVNR 4568\u{A0}150392, Tel.\u{A0}0664\u{A0}1234567');

    expect(masked).not.toContain('150392');
    expect(masked).not.toContain('12345');
  });

  it('does not mask allowlisted values', () => {
    expect(new PiiMasker({ allowlist: ['4568 150392'] }).mask('SVNR 4568 150392')).toBe('SVNR 4568 150392');
  });

  it('lets strategies be overridden per type', () => {
    const custom = new PiiMasker({ strategies: { [EntityType.Iban]: new TypeLabelMask() } });

    expect(custom.mask('IBAN AT61 1904 3002 3457 3201')).toBe('IBAN [IBAN]');
  });

  it('accepts plain functions as strategies and fallback', () => {
    const custom = new PiiMasker({
      strategies: { SVNR: (e) => `<${String(e.value.length)}>` },
      fallback: () => '…',
    });

    expect(custom.mask('SVNR 4568 150392, Sehr geehrte Frau Musterfrau, IBAN AT61 1904 3002 3457 3201')).toBe(
      'SVNR <11>, Sehr geehrte Frau …, IBAN AT61 **** **** **** 3201',
    );
  });

  it('looks up a learned type by its label first, then by its type', () => {
    const detectors = [
      (): Entity[] => [
        createEntity({ type: EntityType.Other, value: 'VN-1', offset: 0, label: 'INSURANCE_NUMBER' }),
        createEntity({ type: EntityType.Other, value: 'VN-2', offset: 5, label: 'POLICY' }),
      ],
    ];

    expect(new PiiMasker({ detectors }).mask('VN-1 VN-2')).toBe('[INSURANCE_NUMBER] [POLICY]');
    expect(new PiiMasker({ detectors, strategies: { OTHER: () => 'o', POLICY: () => 'p' } }).mask('VN-1 VN-2')).toBe(
      'o p',
    );
  });

  it('falls through a strategy set to undefined', () => {
    expect(new PiiMasker({ strategies: { IBAN: undefined } }).mask('IBAN AT61 1904 3002 3457 3201')).toBe(
      'IBAN AT61 **** **** **** 3201',
    );
  });

  it('has IBAN and phone defaults', () => {
    expect(Object.keys(defaultMaskingStrategies())).toEqual(['IBAN', 'PHONE']);
  });
});

describe('PartialMask', () => {
  it.each([
    [2, 2, '*', 'AB 12 34 CD', 'AB ** ** CD'],
    [4, 4, '*', 'AB12345', '*******'],
    [2, 2, '*', 'ABCD', '****'],
    [1, 0, '*', 'Müller', 'M*****'],
    [0, 1, '#', '12345', '####5'],
  ])('keepStart %i, keepEnd %i, %s: %s → %s', (keepStart, keepEnd, maskChar, value, expected) => {
    expect(new PartialMask({ keepStart, keepEnd, maskChar }).mask(entity(value))).toBe(expected);
  });

  it('defaults to keeping nothing with "*"', () => {
    expect(new PartialMask().mask(entity('AB C'))).toBe('** *');
  });

  it.each([-1, 1.5, Number.NaN])('rejects keepStart %s', (keepStart) => {
    expect(() => new PartialMask({ keepStart, keepEnd: 0 })).toThrow(RangeError);
  });
});

describe('TypeLabelMask', () => {
  it('has a configurable format', () => {
    expect(new TypeLabelMask({ format: '<%s>' }).mask(entity('Maria', EntityType.Person))).toBe('<PERSON>');
  });

  it('accepts a function as format', () => {
    expect(new TypeLabelMask({ format: (type) => type.toLowerCase() }).mask(entity('Maria', EntityType.Person))).toBe(
      'person',
    );
  });

  it.each([
    ['%%s %s', '%s PERSON'],
    ['%1$s/%1$s', 'PERSON/PERSON'],
    ['100%%', '100%'],
  ])('supports sprintf %%, %%s and %%1$s: %s', (format, expected) => {
    expect(new TypeLabelMask({ format }).mask(entity('Maria', EntityType.Person))).toBe(expected);
  });

  it.each(['%d', '%s %s', '%', '%2$s', 'a%'])(
    'rejects format %j that PHP sprintf would not render with one string',
    (format) => {
      expect(() => new TypeLabelMask({ format })).toThrow(TypeError);
    },
  );
});

describe('PHP parity (fixtures/masking.json)', () => {
  const fixture = loadFixture('masking');

  it.each(fixture.partialMask)('partialMask: $case', ({ strategy, value, masked }) => {
    const { keepStart, keepEnd, maskChar } = strategy.options as {
      keepStart: number;
      keepEnd: number;
      maskChar: string;
    };

    expect(new PartialMask({ keepStart, keepEnd, maskChar }).mask(entity(value))).toBe(masked);
  });

  it('partialMask: negative keep', () => {
    expect(() => new PartialMask({ keepStart: -1, keepEnd: 0 })).toThrow(
      fixture.partialMaskNegative.error?.message ?? 'missing fixture',
    );
  });

  it.each(fixture.typeLabelMask)('typeLabelMask: $format', ({ format, type, masked }) => {
    expect(new TypeLabelMask({ format }).mask(entity('Maria', type as EntityType))).toBe(masked);
  });

  it.each(fixture.masker)('masker: $case', ({ text, masked }) => {
    expect(new PiiMasker().mask(text)).toBe(masked);
  });

  it.each(loadFixture('redaction').cases)('redaction.json mask: $case', ({ text, mask }) => {
    expect(new PiiMasker().mask(text)).toBe(mask);
  });

  it.each(loadFixture('redaction').configured.filter((c) => c.customTypes.length === 0))(
    'redaction.json configured mask: $case',
    ({ allowlist, text, mask }) => {
      expect(new PiiMasker({ allowlist }).mask(text)).toBe(mask);
    },
  );
});
