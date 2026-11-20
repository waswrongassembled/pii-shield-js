import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, matchAll, WORD_CHARS } from '../internal/pcre.js';
import { isAuthorityContact, isMobileNumber } from './authority-context.js';
import type { ContactDetectorOptions } from './email.js';

const D = DIGIT;
/*
 * Same language as PHP's pattern, with one change against catastrophic backtracking: each digit group
 * must run to the end of its digit run ((?!\d)). In PHP's form "(?:[ /-]?\d{2,}){1,5}" a long digit run
 * can be split into groups in O(n^4) ways before the final lookahead fails (PHP throws "Backtrack limit
 * exhausted" there; JavaScript has no limit and hangs). A match can only end where a digit run ends, and
 * splitting a run only uses up groups, so forbidding the split never changes which text matches.
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
      // PHP counts ASCII digits only here (no /u).
      if (value.replace(/[^0-9]/g, '').length < MIN_DIGITS) {
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
