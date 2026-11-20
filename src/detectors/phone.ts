import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { asciiDigits, DIGIT, matchAll, WORD_CHARS } from '../internal/pcre.js';
import { isAuthorityContact, isMobileNumber } from './authority-context.js';
import type { ContactDetectorOptions } from './email.js';

const D = DIGIT;
/*
 * PHP's pattern as of clarifile PR #95: each digit group must run to the end of its digit run ((?!\d)).
 * The older form "(?:[ /-]?\d{2,}){1,5}" split a long digit run into groups in O(n^4) ways before the final
 * lookahead failed (PHP threw "Backtrack limit exhausted"; JavaScript has no limit and hangs). A match can
 * only end where a digit run ends, so the lookahead never changes which text matches.
 */
const PATTERN = new RegExp(
  String.raw`(?<![${WORD_CHARS}+\/])(?:(?:\+|00)${D}{1,3}|0${D}{1,4})(?:[ \/\-]?${D}{2,}(?!${D})){1,5}(?![${WORD_CHARS}\/])`,
  'gu',
);
const MIN_DIGITS = 7;

/**
 * International (+43 ..., 0049 ...) and national (0664/...) phone numbers.
 * Requires at least 7 digits; dates and times do not match because "." and ":" are not separators.
 */
export class PhoneDetector implements Detector {
  readonly name = 'phone';
  readonly #keepAuthorityContacts: boolean;

  constructor(options: ContactDetectorOptions = {}) {
    this.#keepAuthorityContacts = options.keepAuthorityContacts ?? true;
  }

  detect(text: string): Entity[] {
    const entities: Entity[] = [];
    for (const { value, offset } of matchAll(PATTERN, text)) {
      // PHP counts ASCII digits only here (no /u), so it drops numbers in other digits (docs/DEVIATIONS.md).
      if (asciiDigits(value).replace(/[^0-9]/g, '').length < MIN_DIGITS) {
        continue;
      }
      if (this.#keepAuthorityContacts && !isMobileNumber(value) && isAuthorityContact(text, offset)) {
        continue;
      }
      entities.push(createEntity({ type: EntityType.Phone, value, offset, confidence: 0.8, detector: 'phone' }));
    }

    return entities;
  }
}
