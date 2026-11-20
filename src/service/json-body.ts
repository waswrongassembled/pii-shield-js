/**
 * A request body decoded like PHP's `json_decode($body, true, 16, JSON_THROW_ON_ERROR)`: invalid UTF-8,
 * a byte order mark, lone surrogate escapes (`"\ud800"`) and more than 15 nested arrays/objects are
 * invalid JSON. JSON.parse() alone accepts the last three.
 */
export type JsonBody = Readonly<Record<string, unknown>>;

/** PHP's depth 16 counts the scalars inside the innermost container too. */
const MAX_NESTING = 15;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ParsedBody =
  { ok: true; body: JsonBody } | { ok: false; error: 'Invalid JSON.' | 'Expected a JSON object.' };

export function parseJsonBody(bytes: Uint8Array): ParsedBody {
  let data: unknown;
  try {
    data = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return { ok: false, error: 'Invalid JSON.' };
  }
  if (!wellFormed(data, 0)) {
    return { ok: false, error: 'Invalid JSON.' };
  }
  // A JSON list is a PHP array too, so PHP accepts it as a body (without any of the named fields).
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'Expected a JSON object.' };
  }

  return { ok: true, body: Array.isArray(data) ? {} : (data as JsonBody) };
}

function wellFormed(value: unknown, depth: number): boolean {
  if (typeof value === 'string') {
    return value.isWellFormed();
  }
  if (typeof value !== 'object' || value === null) {
    return true;
  }
  if (depth + 1 > MAX_NESTING) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => wellFormed(item, depth + 1));
  }

  return Object.entries(value).every(([key, item]) => key.isWellFormed() && wellFormed(item, depth + 1));
}
