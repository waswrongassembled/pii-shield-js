const WEIGHTS = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6] as const;

/**
 * Austrian social security number (Sozialversicherungsnummer).
 *
 * Format: 3-digit serial, 1 check digit, 6-digit birth date (DDMMYY).
 * Check digit = sum(digit_i * weight_i) mod 11 with weights 3,7,9,(check),5,8,4,2,1,6.
 * A remainder of 10 is never issued. ASCII whitespace and hyphens are ignored; only ASCII digits count.
 */
export function isValidAtSvnr(candidate: string): boolean {
  const digits = candidate.replace(/[\t\n\v\f\r -]/g, '');
  if (!/^[1-9][0-9]{9}$/.test(digits)) {
    return false;
  }

  let sum = 0;
  WEIGHTS.forEach((weight, i) => {
    sum += Number(digits[i]) * weight;
  });
  const check = sum % 11;

  return check !== 10 && check === Number(digits[3]);
}
