import { describe, expect, it } from 'vitest';

import { isValidAtSvnr, isValidDeTaxId, isValidIban, type Validator } from '../src/index.js';
import { loadFixture } from './support/fixtures.js';

// Ported from tests/Validator/*Test.php.
const cases: Record<string, { validator: Validator; valid: [string, string][]; invalid: [string, string][] }> = {
  AtSvnrValidator: {
    validator: isValidAtSvnr,
    valid: [
      ['fixture 02', '4568 150392'],
      ['readme example', '1237 010180'],
      ['without space', '1237010180'],
    ],
    invalid: [
      ['wrong check digit', '1234 010180'],
      ['check sum 10 is never valid', '1000 010180'],
      ['leading zero', '0237 010180'],
      ['too short', '1237 01018'],
      ['too long', '1237 0101801'],
      ['letters', '12A7 010180'],
      ['empty', ''],
    ],
  },
  IbanValidator: {
    validator: isValidIban,
    valid: [
      ['AT grouped (fixture 01)', 'AT61 1904 3002 3457 3201'],
      ['AT compact', 'AT611904300234573201'],
      ['DE', 'DE89 3704 0044 0532 0130 00'],
      ['CH', 'CH93 0076 2011 6238 5295 7'],
      ['lowercase', 'at61 1904 3002 3457 3201'],
    ],
    invalid: [
      ['wrong check digits', 'AT62 1904 3002 3457 3201'],
      ['typo in account', 'AT61 1904 3002 3457 3202'],
      ['too short', 'AT61 1904'],
      ['no country code', '6119 0430 0234 5732 01'],
      ['special characters', 'AT61-1904-3002-3457-3201'],
      ['leading character', 'XAT61 1904 3002 3457 3201'],
      ['trailing character', 'AT61 1904 3002 3457 3201 X'],
      ['empty', ''],
    ],
  },
  DeTaxIdValidator: {
    validator: isValidDeTaxId,
    valid: [
      ['one digit twice', '86095742719'],
      ['one digit three times', '65929970489'],
      ['grouped with spaces', '86 095 742 719'],
      ['check digit 10 becomes 0', '82511470930'],
      ['tenth digit is the repeated one', '24051867317'],
    ],
    invalid: [
      ['wrong check digit', '86095742718'],
      ['leading zero', '06095742719'],
      ['no repeated digit', '12345678903'],
      ['too short', '8609574271'],
      ['letters', '8609574271A'],
      ['leading character', 'x86095742719'],
      ['one digit too many', '860957427190'],
      ['empty', ''],
    ],
  },
};

const validators: Record<string, Validator> = Object.fromEntries(
  Object.entries(cases).map(([name, c]) => [name, c.validator]),
);

describe.each(Object.entries(cases))('%s', (_name, { validator, valid, invalid }) => {
  it.each(valid)('accepts %s', (_case, input) => {
    expect(validator(input)).toBe(true);
  });

  it.each(invalid)('rejects %s', (_case, input) => {
    expect(validator(input)).toBe(false);
  });
});

describe('PHP parity (fixtures/validators.json)', () => {
  const samples = Object.entries(loadFixture('validators').validators).flatMap(([name, list]) =>
    list.map((s) => ({ name, ...s })),
  );

  it.each(samples)('$name: $case', ({ name, input, valid }) => {
    const validator = validators[name];

    expect(validator, `no validator for ${name}`).toBeDefined();
    expect(validator?.(input)).toBe(valid);
  });
});
