import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, matchAll, WORD_CHARS, WORD_START } from '../internal/pcre.js';

/**
 * Words that introduce a file or customer number (regex source); also used to check a model's findings.
 *
 * @internal
 */
export const FILE_NUMBER_KEYWORDS = String.raw`(?:Zahl|GZ|Gz\.|Geschäftszahl|Aktenzahl|Aktenzeichen|Az\.|Kundennummer|Kunden-Nr\.?|Vertragsnummer|Versicherungsnummer|Verwendungszweck)`;

const PATTERN = new RegExp(
  String.raw`${WORD_START}${FILE_NUMBER_KEYWORDS}[ \t]*:?[ \t]*(?<ref>(?=[A-Z0-9.\/\-]*${DIGIT})[A-Z0-9][A-Z0-9.\/\-]{2,}[A-Z0-9])(?![${WORD_CHARS}\/\-])`,
  'dgu',
);

/**
 * Case and customer references (Aktenzahl, Geschäftszahl, Kundennummer, ...).
 * Only matches after a keyword; the reference must contain a digit.
 */
export class FileNumberDetector implements Detector {
  readonly name = 'file_number';

  detect(text: string): Entity[] {
    return matchAll(PATTERN, text, 'ref').map(({ value, offset }) =>
      createEntity({ type: EntityType.FileNumber, value, offset, confidence: 0.9, detector: 'file_number' }),
    );
  }
}
