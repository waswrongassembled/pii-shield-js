/**
 * PHP's `json_encode()` with default flags, for a placeholder mapping. The vault plaintext must match PHP
 * byte for byte so payloads are identical for the same nonce:
 *
 * - an empty mapping is `[]` (an empty PHP array is a list);
 * - `/` is escaped as `\/`;
 * - every non-ASCII UTF-16 code unit becomes a lowercase `\u` escape (astral characters as surrogate pairs);
 * - `\b \f \n \r \t` use their short forms, other control characters `\u00xx`; DEL (0x7f) stays raw.
 *
 * A lone surrogate is escaped like any other code unit. PHP cannot produce one (its strings are UTF-8)
 * and its json_decode() rejects it, see docs/DEVIATIONS.md.
 *
 * @internal
 */
export function encodePhpJson(mapping: Readonly<Record<string, string>>): string {
  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    return '[]';
  }

  return `{${entries.map(([key, value]) => `${encodeString(key)}:${encodeString(value)}`).join(',')}}`;
}

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x2f: '\\/',
  0x5c: '\\\\',
};

function encodeString(value: string): string {
  let result = '"';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    const short = SHORT_ESCAPES[unit];
    if (short !== undefined) {
      result += short;
    } else if (unit < 0x20 || unit > 0x7f) {
      result += `\\u${unit.toString(16).padStart(4, '0')}`;
    } else {
      result += value.charAt(i);
    }
  }

  return `${result}"`;
}
