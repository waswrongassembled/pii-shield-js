import type { Detector, Validator } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { checkdate, DIGIT, matchAll } from '../internal/pcre.js';
import { isValidAtSvnr } from '../validators/at-svnr.js';

const PATTERN = new RegExp(String.raw`(?<!${DIGIT})${DIGIT}{4}(?:[ -]|[ \t]*\n[ \t]*)?${DIGIT}{6}(?!${DIGIT})`, 'gu');

/**
 * Austrian social security number: "4568 150392", "4568-150392", "4568150392", also split across a line break (OCR).
 * With a hyphen or line break the last six digits must be a valid date (DDMMYY).
 */
export class AtSvnrDetector implements Detector {
  readonly name = 'at_svnr';
  readonly #validator: Validator;

  constructor(options: { validator?: Validator } = {}) {
    this.#validator = options.validator ?? isValidAtSvnr;
  }

  detect(text: string): Entity[] {
    return matchAll(PATTERN, text)
      .filter(
        ({ value }) => this.#validator(value) && (/^[0-9]+$/.test(value.replaceAll(' ', '')) || hasBirthDate(value)),
      )
      .map(({ value, offset }) =>
        createEntity({ type: EntityType.AtSvnr, value, offset, confidence: 1, detector: 'at_svnr' }),
      );
  }
}

/**
 * A hyphen or line break also joins file numbers ("VWA-2026-100084") and a date's year with the next line,
 * and the checksum passes for about one in eleven: these variants need a plausible DDMMYY birth date.
 */
function hasBirthDate(value: string): boolean {
  const birth = value.replace(/[^0-9]/g, '').slice(4);

  return checkdate(Number(birth.slice(2, 4)), Number(birth.slice(0, 2)), 2000 + Number(birth.slice(4, 6)));
}
