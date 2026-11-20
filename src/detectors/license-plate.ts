import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, matchAll, WORD_CHARS, WORD_START } from '../internal/pcre.js';

const PATTERN = new RegExp(
  String.raw`${WORD_START}Kennzeichen[ \t]*:?[ \t]+(?<plate>[A-ZÄÖÜ]{1,3}[\- ](?:[A-Z]{1,2} )?${DIGIT}{1,6}[A-Z]{0,3})(?![${WORD_CHARS}\-])`,
  'dgu',
);

/**
 * AT and DE license plates, only after the keyword "Kennzeichen".
 */
export class LicensePlateDetector implements Detector {
  readonly name = 'license_plate';

  detect(text: string): Entity[] {
    return matchAll(PATTERN, text, 'plate').map(({ value, offset }) =>
      createEntity({ type: EntityType.LicensePlate, value, offset, confidence: 0.9, detector: 'license_plate' }),
    );
  }
}
