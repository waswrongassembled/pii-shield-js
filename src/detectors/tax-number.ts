import type { Detector, Validator } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, matchAll } from '../internal/pcre.js';
import { isValidDeTaxId } from '../validators/de-tax-id.js';

const D = DIGIT;
const AT_STEUERNUMMER = new RegExp(String.raw`(?<![${D}\/])${D}{2}[ -]?${D}{3}\/${D}{4}(?![${D}\/])`, 'gu');
const DE_STEUERNUMMER = new RegExp(String.raw`(?<![${D}\/])${D}{2,3}\/${D}{3,4}\/${D}{4,5}(?![${D}\/])`, 'gu');
const DE_STEUER_ID = new RegExp(String.raw`(?<!${D})${D}{2} ?${D}{3} ?${D}{3} ?${D}{3}(?!${D})`, 'gu');

/**
 * AT Steuernummer (e.g. "46 123/4567"), DE Steuernummer (e.g. "181/815/08155")
 * and DE Steuer-ID (11 digits, checksum-validated).
 */
export class TaxNumberDetector implements Detector {
  readonly name = 'tax_number';
  readonly #taxIdValidator: Validator;

  constructor(options: { taxIdValidator?: Validator } = {}) {
    this.#taxIdValidator = options.taxIdValidator ?? isValidDeTaxId;
  }

  detect(text: string): Entity[] {
    const entities: Entity[] = [];
    for (const pattern of [AT_STEUERNUMMER, DE_STEUERNUMMER]) {
      for (const { value, offset } of matchAll(pattern, text)) {
        entities.push(
          createEntity({ type: EntityType.TaxNumber, value, offset, confidence: 0.9, detector: 'tax_number' }),
        );
      }
    }
    for (const { value, offset } of matchAll(DE_STEUER_ID, text)) {
      if (this.#taxIdValidator(value)) {
        entities.push(
          createEntity({ type: EntityType.TaxNumber, value, offset, confidence: 1, detector: 'de_tax_id' }),
        );
      }
    }

    return entities.sort((a, b) => a.offset - b.offset);
  }
}
