import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, LINE_END, LINE_START, matchAll } from '../internal/pcre.js';

const D = DIGIT;
const PATTERN = new RegExp(
  String.raw`${LINE_START}(?<address>\p{Lu}[\p{L}.' \-]*?[ \t]${D}{1,4}[a-zA-Z]?(?:\/${D}{1,4}[a-zA-Z]?)*[ \t]*\n(?:[ \t]*\n){0,2}(?:(?:A|D|CH)-)?(?:[1-9]${D}{3}|${D}{5})[ \t]+\p{Lu}[\p{L}.' \-]*\p{L})[ \t]*${LINE_END}`,
  'dgu',
);

/**
 * Two-line postal address as found in the recipient block:
 * "Street 12[/3]" followed by "AT 4-digit or DE 5-digit postcode + city", with up to two blank
 * lines in between (OCR output).
 *
 * Single-line addresses ("Hauptplatz 1, 6999 Musterstadt") are typically the sender's
 * letterhead and are kept. Street names without house number are left to NER.
 */
export class PostalAddressDetector implements Detector {
  readonly name = 'postal_address';

  detect(text: string): Entity[] {
    return matchAll(PATTERN, text, 'address').map(({ value, offset }) =>
      createEntity({ type: EntityType.Address, value, offset, confidence: 0.8, detector: 'postal_address' }),
    );
  }
}
