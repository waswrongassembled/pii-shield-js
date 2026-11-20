import { asciiDigits } from '../internal/pcre.js';

/**
 * German tax identification number (Steuerliche Identifikationsnummer, 11 digits).
 *
 * Structure: no leading zero; within the first 10 digits exactly one digit occurs
 * two or three times, all others at most once. Check digit: ISO 7064 MOD 11,10.
 * Spaces are ignored, any decimal digit (\p{Nd}) counts (PHP: ASCII only). Like PHP's "$", a single trailing "\n" is accepted.
 */
export function isValidDeTaxId(candidate: string): boolean {
  const digits = asciiDigits(candidate).replaceAll(' ', '');
  if (!/^[1-9][0-9]{10}\n?$/.test(digits)) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const digit of digits.slice(0, 10)) {
    counts.set(digit, (counts.get(digit) ?? 0) + 1);
  }
  const repeated = [...counts.values()].filter((count) => count > 1);
  if (repeated.length !== 1 || Math.max(...repeated) > 3) {
    return false;
  }

  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (Number(digits[i]) + product) % 10;
    if (sum === 0) {
      sum = 10;
    }
    product = (sum * 2) % 11;
  }
  let check = 11 - product;
  if (check === 10) {
    check = 0;
  }

  return check === Number(digits[10]);
}
