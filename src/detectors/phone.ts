import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, matchAll, WORD_CHARS } from '../internal/pcre.js';
import { isAuthorityContact, isMobileNumber } from './authority-context.js';
import type { ContactDetectorOptions } from './email.js';

const D = DIGIT;
const PATTERN = new RegExp(
  String.raw`(?<![${WORD_CHARS}+\/])(?:(?:\+|00)${D}{1,3}|0${D}{1,4})(?:[ \/\-]?${D}{2,}){1,5}(?![${WORD_CHARS}\/])`,
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
