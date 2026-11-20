/**
 * IBAN according to ISO 13616 (mod 97 check). ASCII whitespace is ignored, ASCII letters are case-insensitive.
 */
export function isValidIban(candidate: string): boolean {
  // PHP's strtoupper() only maps a-z.
  const iban = candidate.replace(/[\t\n\v\f\r ]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase());
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)) {
    return false;
  }

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const value = code <= 0x39 ? char : String(code - 55);
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1;
}
