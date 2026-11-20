import { asciiDigits, LINE_START, SPACE, WORD, WORD_END, WORD_START } from '../internal/pcre.js';

/**
 * Heuristic: is a contact detail (e-mail, phone) the sender authority's own contact?
 *
 * Authority contact data is needed for the action steps ("where do I send my objection?")
 * and is not the recipient's personal data, so it is kept by default. A sentence counts as
 * authority context if it speaks in first person plural ("erreichen Sie uns") or refers
 * to an authority or to filing something ("einzubringen"). The sentence, not the whole line:
 * OCR and copied text put whole paragraphs on one line, and "Sie haben Einspruch erhoben.
 * Ihre Nummer ist ..." must not keep the recipient's number.
 *
 * Never authority context: a sentence about the recipient's contact ("Ihre Telefonnummer") and mobile
 * numbers (authorities publish landlines; see isMobileNumber()). First person singular is no signal:
 * case workers write "stehe ich Ihnen unter ... zur Verfügung".
 *
 * Window sizes and the letterhead limit count UTF-8 bytes, as in PHP, so the same text gives the same result.
 *
 * @internal
 */

const KEYWORDS = new RegExp(
  `${WORD_START}(?:uns|wir|unser${WORD}*|einzubringen|Einspruch|Beschwerde|Bezirkshauptmannschaft|Finanzamt${WORD}*|Magistrat${WORD}*|Behörde${WORD}*|Gericht${WORD}*|Amt)${WORD_END}`,
  'iu',
);
/** The recipient's own contact: "Ihre Telefonnummer", "Ihrer Rufnummer", "Ihre E-Mail-Adresse" (not "Ihrer E-Mail vom ..."). */
const PERSONAL = new RegExp(
  `${WORD_START}Ihre[mnrs]?${SPACE}+(?:(?:Telefon|Handy|Mobil|Ruf|Rückruf|Mobilfunk)${WORD}*|(?:E-Mail|Mail)-?Adresse${WORD}*|Kontaktdaten)${WORD_END}`,
  'u',
);
/**
 * Mobile numbers. AT: the common mobile blocks only (0662, 065xx, 07xxx are landlines). DE and CH only with
 * the country code: national "015x" or "07xx" are Austrian landlines too.
 */
const MOBILE =
  /^(?:(?:\+|00)43|0)(?:650|660|664|676|677|678|680|681|688|699)|^(?:\+|00)49(?:15|16|17)|^(?:\+|00)41(?:7[5-9])/;
/** Names of authorities: a letterhead needs one ("uns" or "wir" are not enough there). */
const AUTHORITY_NAMES = new RegExp(
  `${WORD_START}(?:Bezirkshauptmannschaft|Finanzamt|Magistrat|Magistratsabteilung|Behörde|Gericht|Bezirksgericht|Landesgericht|Amtsgericht|Amt|Gemeindeamt|Gemeinde|Stadtgemeinde|Marktgemeinde|Landesregierung|Ministerium|Polizei|Polizeiinspektion|Landespolizeidirektion|Stadtverwaltung)${WORD_END}`,
  'iu',
);
/** Short forms authorities put before their name in a domain ("bh-musterstadt.gv.at"). */
const SECOND_LEVEL_DOMAINS: readonly string[] = ['gv', 'co', 'or', 'ac', 'gov'];
const DOMAIN_PREFIXES: readonly string[] = [
  'bh',
  'fa',
  'ma',
  'mag',
  'gem',
  'stadt',
  'markt',
  'land',
  'lpd',
  'bg',
  'lg',
];
/** The authority's name must be on one of the first lines of the letterhead. */
const AUTHORITY_NAME_LINES = 2;
const LETTERHEAD_LINES = 6;
const LETTERHEAD_BYTES = 2_000;
const SENTENCE_WINDOW = 400;
/** Abbreviations whose dot does not end a sentence ("Abt. Verkehr, Tel. 05572 ..."). */
const ABBREVIATIONS = [
  'Abs',
  'Abt',
  'Art',
  'bzw',
  'ca',
  'Dr',
  'DI',
  'Fa',
  'Fr',
  'gem',
  'GZ',
  'Hr',
  'inkl',
  'Ing',
  'lit',
  'lt',
  'Mag',
  'Nr',
  'Prof',
  'Str',
  'Tel',
  'usw',
  'vgl',
  'z.B',
  'Zl',
];
const NO_SENTENCE_END = [...ABBREVIATIONS.map((a) => a.replaceAll('.', String.raw`\.`)), String.raw`\p{Lu}`]
  .map((a) => WORD_START + a)
  .join('|');
const SENTENCE_END = new RegExp(String.raw`(?<!${NO_SENTENCE_END})[.!?]${SPACE}+(?=\p{Lu})`, 'gu');

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether the contact at `offset` (UTF-16 index) is in a sentence that speaks for the authority.
 */
export function isAuthorityContact(text: string, offset: number): boolean {
  const sentence = sentenceAround(text, offset);

  return KEYWORDS.test(sentence) && !PERSONAL.test(sentence);
}

/**
 * Whether a phone number is a mobile number (AT, DE, CH). Mobile numbers are treated as personal even
 * next to authority keywords: "Ihren Einspruch haben wir unter 0664 ... notiert".
 */
export function isMobileNumber(phone: string): boolean {
  const digits = asciiDigits(phone)
    .replace(/[^0-9+]/g, '')
    // "+43 0664 ..." / "+43 (0)664 ...": the trunk zero after the country code is not part of the number
    .replace(/^((?:\+|00)[0-9]{2})0/, '$1');

  return MOBILE.test(digits);
}

/** Whether `offset` (UTF-16 index) lies in the letterhead of an authority (see letterhead()). */
export function isInLetterhead(text: string, offset: number): boolean {
  const head = letterhead(text);

  return head !== null && offset < head.length;
}

/**
 * Whether an e-mail address belongs to the authority in the letterhead: the domain's name (the label
 * before the top-level domain, e.g. "musterhausen" in "parken@musterhausen.example") equals a word of the
 * line that names the authority, optionally after a known short form ("bh-musterstadt"). A similar
 * domain ("musterhausen-fitness") does not count: when in doubt, the address is redacted.
 *
 * `authority` is the authority line of the text (authorityLine()), passed in so it is computed once per text.
 */
export function isAuthorityEmail(text: string, email: string, authority: string | null = authorityLine(text)): boolean {
  const at = email.lastIndexOf('@');
  if (authority === null || at === -1) {
    return false;
  }
  // PHP's strtolower() only maps A-Z.
  const labels = email
    .slice(at + 1)
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .split('.');
  if (labels.length < 2) {
    return false;
  }
  const words = authority
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((w) => w !== '' && [...w].length >= 5);
  // "bh-musterstadt.gv.at": the name is the label before a second-level domain like "gv" or "co"
  let nameIndex = labels.length - 2;
  if (nameIndex > 0 && SECOND_LEVEL_DOMAINS.includes(labels[nameIndex] ?? '')) {
    nameIndex--;
  }
  const parts = (labels[nameIndex] ?? '').split('-');
  const name = parts.pop() ?? '';

  return words.includes(name) && parts.every((p) => DOMAIN_PREFIXES.includes(p));
}

/** The line of the letterhead that names the authority, or null. */
export function authorityLine(text: string): string | null {
  const head = letterheadBytes(text);

  return head === null ? null : authorityLineOf(head);
}

/**
 * The sentence around an offset, within its line. A sentence ends at ".", "!" or "?" followed by
 * whitespace and an upper-case letter, unless the dot ends a known abbreviation or an initial.
 *
 * Only SENTENCE_WINDOW bytes on each side are looked at: OCR text can be one long line with many
 * contacts, and scanning the whole line per contact would be quadratic.
 */
function sentenceAround(text: string, offset: number): string {
  // Start and end on whole characters, at least SENTENCE_WINDOW UTF-8 bytes away (or at the text's ends).
  let from = offset;
  for (let bytes = 0; from > 0 && bytes < SENTENCE_WINDOW;) {
    const step = isLowSurrogateAt(text, from - 1) && isHighSurrogateAt(text, from - 2) ? 2 : 1;
    bytes += utf8Length(text, from - step);
    from -= step;
  }
  let to = offset;
  for (let bytes = 0; to < text.length && bytes < SENTENCE_WINDOW;) {
    const step = isHighSurrogateAt(text, to) && isLowSurrogateAt(text, to + 1) ? 2 : 1;
    bytes += utf8Length(text, to);
    to += step;
  }
  let window = text.slice(from, to);
  let relative = offset - from;

  const lineStart = window.slice(0, relative).lastIndexOf('\n');
  if (lineStart !== -1) {
    window = window.slice(lineStart + 1);
    relative -= lineStart + 1;
  }
  const lineEnd = window.indexOf('\n', relative);
  if (lineEnd !== -1) {
    window = window.slice(0, lineEnd);
  }

  // preg_split() into sentences; the last one starting at or before the offset.
  let start = 0;
  let end = window.length;
  for (const match of window.matchAll(SENTENCE_END)) {
    const next = match.index + match[0].length;
    if (next > relative) {
      end = match.index;
      break;
    }
    start = next;
  }

  return window.slice(start, end);
}

/**
 * The letterhead: the first block of the text, ending at a blank line or at the recipient's salutation
 * within the first LETTERHEAD_LINES lines, and only when it names an authority. Otherwise null: without
 * a clear letterhead everything is treated as personal data.
 */
function letterhead(text: string): string | null {
  const bytes = letterheadBytes(text);

  return bytes === null ? null : strictUtf8.decode(bytes);
}

const BLOCK_BOUNDARY = new RegExp(
  String.raw`(?=(\r\n|[\n\v\f\r\x85\u{2028}\u{2029}]))\1[ \t]*(?=(\r\n|[\n\v\f\r\x85\u{2028}\u{2029}]))\2|${LINE_START}(?:Herrn?|Frau|An)${WORD_END}`,
  'u',
);

/** The letterhead as UTF-8 bytes; PHP finds it with byte offsets, and the exact cut decides the result. */
function letterheadBytes(text: string): Uint8Array | null {
  // Only the start of the text is searched: this runs for every e-mail found and must not scan the text.
  // LETTERHEAD_BYTES UTF-16 units encode to at least as many bytes; one more keeps a surrogate pair whole.
  const head = utf8.encode(text.slice(0, LETTERHEAD_BYTES + 1)).subarray(0, LETTERHEAD_BYTES);
  // PHP matches the lines without /u, on bytes: "\R" there also ends a line at the byte 0x85, which
  // occurs inside UTF-8 characters like "Å" (C3 85). Latin-1 maps each byte to one UTF-16 unit.
  const latin1 = bytesToLatin1(head);
  const lines = new RegExp(String.raw`^(?:[^\r\n]*(?=(\r\n|[\n\v\f\r\x85]))\1){${String(LETTERHEAD_LINES)}}`).exec(
    latin1,
  );
  const limit = lines === null ? head.length : lines[0].length;
  // A blank line right after the last allowed line still ends the block.
  const block = head.subarray(0, limit + 2);
  let blockText: string;
  try {
    blockText = strictUtf8.decode(block);
  } catch {
    return null; // the cut split a character: PHP's /u regex fails on the invalid UTF-8
  }
  const boundary = BLOCK_BOUNDARY.exec(blockText);
  if (boundary === null) {
    return null;
  }
  const end = utf8.encode(blockText.slice(0, boundary.index)).length;
  if (end > limit) {
    return null;
  }
  const result = block.subarray(0, end);

  return authorityLineOf(result) === null ? null : result;
}

function authorityLineOf(letterheadBytes: Uint8Array): string | null {
  // PHP splits without /u, on bytes (see letterheadBytes()); a piece that is no valid UTF-8 never matches.
  for (const piece of bytesToLatin1(letterheadBytes)
    .split(/\r\n|[\n\v\f\r\x85]/)
    .slice(0, AUTHORITY_NAME_LINES)) {
    let line: string;
    try {
      line = strictUtf8.decode(Uint8Array.from(piece, (c) => c.charCodeAt(0)));
    } catch {
      continue;
    }
    if (AUTHORITY_NAMES.test(line)) {
      return line;
    }
  }

  return null;
}

/** One UTF-16 unit per byte (ISO-8859-1), so byte-mode PCRE patterns can be run as JavaScript regexes. */
function bytesToLatin1(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += String.fromCharCode(byte);
  }

  return result;
}

function isHighSurrogateAt(text: string, i: number): boolean {
  const unit = text.charCodeAt(i);

  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogateAt(text: string, i: number): boolean {
  const unit = text.charCodeAt(i);

  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** UTF-8 length of the character starting at `i` (a lone surrogate encodes as U+FFFD, 3 bytes). */
function utf8Length(text: string, i: number): number {
  const unit = text.charCodeAt(i);
  if (unit < 0x80) {
    return 1;
  }
  if (unit < 0x800) {
    return 2;
  }
  if (isHighSurrogateAt(text, i) && isLowSurrogateAt(text, i + 1)) {
    return 4;
  }

  return 3;
}
