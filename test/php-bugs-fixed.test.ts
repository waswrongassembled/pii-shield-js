/**
 * PHP bugs with privacy impact that the port fixes instead of reproducing (docs/DEVIATIONS.md, "PHP bugs
 * fixed in the port"). The PHP results of these fixture cases are left out of the parity tests
 * (FIXED_IN_PORT); here the port's own result is checked.
 */
import { describe, expect, it } from 'vitest';
import {
  AtSvnrDetector,
  IbanDetector,
  isValidAtSvnr,
  isValidDeTaxId,
  isValidIban,
  ModelDetector,
  PhoneDetector,
  PiiShield,
  TaxNumberDetector,
} from '../src/index.js';
import { asciiDigits } from '../src/internal/pcre.js';
import { FIXED_IN_PORT, loadRawFixture } from './support/fixtures.js';

describe('FIXED_IN_PORT', () => {
  it('names fixture cases that exist', () => {
    const names: string[] = [];
    const collect = (value: unknown, key: string): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const name = (item as { case?: unknown } | null)?.case;
          if (typeof name === 'string') {
            names.push(`${key}: ${name}`);
          }
          collect(item, key);
        }
      } else if (typeof value === 'object' && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          collect(v, k);
        }
      }
    };
    for (const file of ['validators', 'detectors', 'redaction', 'masking', 'model'] as const) {
      collect(loadRawFixture(file), '');
    }

    for (const entry of FIXED_IN_PORT) {
      expect(
        names.some((n) => n.endsWith(entry)),
        entry,
      ).toBe(true);
    }
  });
});

// docs/UPSTREAM.md #4: detectors match \d under /u, PHP's validators and digit counts accept ASCII only.
describe('decimal digits other than ASCII', () => {
  it('maps every \\p{Nd} digit to its ASCII value', () => {
    expect(asciiDigits('１２３ ٤٥٦ ७८९ ০ 𝟎𝟗𝟘𝟡 a1')).toBe('123 456 789 0 0909 a1');
  });

  it('validates SVNR, tax id and IBAN written with them', () => {
    expect(isValidAtSvnr('１２３７０１０１８０')).toBe(true);
    expect(isValidAtSvnr('١٢٣٧٠١٠١٨٠')).toBe(true);
    expect(isValidAtSvnr('１２３４０１０１８０')).toBe(false);
    expect(isValidDeTaxId('８６０９５７４２７１９')).toBe(true);
    expect(isValidIban('AT٦1 1904 3002 3457 3201')).toBe(true);
  });

  it.each([
    ['fullwidth SVNR', new AtSvnrDetector(), 'SVNR ４５６８ １５０３９２', '４５６８ １５０３９２'],
    ['Arabic-Indic phone number', new PhoneDetector(), 'Privat +٤٣ ٦٦٤ ١٢٣٤٥٦٧', '+٤٣ ٦٦٤ ١٢٣٤٥٦٧'],
    ['fullwidth tax id', new TaxNumberDetector(), 'Steuer-ID ８６０９５７４２７１９', '８６０９５７４２７１９'],
    [
      'IBAN with an Arabic-Indic check digit',
      new IbanDetector(),
      'IBAN AT٦1 1904 3002 3457 3201',
      'AT٦1 1904 3002 3457 3201',
    ],
  ])('detects a %s', (_, detector, text, value) => {
    expect(detector.detect(text).map((e) => e.value)).toEqual([value]);
  });

  it('redacts them with the default detectors', () => {
    const text = 'SVNR ４５６８ １５０３９２, Privat +٤٣ ٦٦٤ ١٢٣٤٥٦٧, Steuer-ID ８６０９５７４２７１９';

    expect(new PiiShield().redact(text).redactedText).toBe('SVNR ⟦SVNR_1⟧, Privat ⟦PHONE_1⟧, Steuer-ID ⟦TAX_NUMBER_1⟧');
  });

  it('keeps a model file number whose only digits are not ASCII', async () => {
    const detector = new ModelDetector({
      location: 'local',
      model: () => Promise.resolve('{"entities":[{"type":"FILE_NUMBER","value":"AB-١"}]}'),
    });

    expect((await detector.detect('Zahl: AB-١')).map((e) => [e.type, e.value])).toEqual([['FILE_NUMBER', 'AB-١']]);
  });
});
