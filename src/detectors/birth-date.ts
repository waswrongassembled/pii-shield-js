import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { checkdate, DIGIT, matchAll, phpIntval, SPACE, WORD_START } from '../internal/pcre.js';

const D = DIGIT;
const S = SPACE;
const PATTERN = new RegExp(
  String.raw`(?:${WORD_START}geb\.(?:${S}*am)?|${WORD_START}geboren(?:${S}+am)?|${WORD_START}Geburtsdatum:?)${S}*(?<date>${D}{1,2}\.${S}?${D}{1,2}\.${S}?${D}{4})(?!${D})`,
  'dgiu',
);

/**
 * Dates are only personal data when they are birth dates. All other dates
 * (deadlines, letter dates) must survive, so this detector requires a birth keyword.
 */
export class BirthDateDetector implements Detector {
  readonly name = 'birth_date';

  detect(text: string): Entity[] {
    return matchAll(PATTERN, text, 'date')
      .filter(({ value }) => {
        const [day = 0, month = 0, year = 0] = value.replaceAll(' ', '').split('.').map(phpIntval);

        return checkdate(month, day, year);
      })
      .map(({ value, offset }) =>
        createEntity({ type: EntityType.BirthDate, value, offset, confidence: 0.95, detector: 'birth_date' }),
      );
  }
}
