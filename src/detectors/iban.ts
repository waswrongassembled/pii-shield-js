import type { Detector, Validator } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DIGIT, matchAll, WORD_END, WORD_START } from '../internal/pcre.js';
import { isValidIban } from '../validators/iban.js';

const GAP = String.raw`(?: |[ \t]*\n[ \t]*)?`;
const PATTERN = new RegExp(
  `${WORD_START}[A-Z]{2}${DIGIT}{2}(?:${GAP}[A-Z0-9]{4}){2,7}(?:${GAP}[A-Z0-9]{1,3})?${WORD_END}`,
  'gu',
);
/** PHP matches this without /u: ASCII whitespace. */
const LAST_GROUP = /^([^]*[^\t\n\v\f\r ])[\t\n\v\f\r ]+[^\t\n\v\f\r ]+$/;

export class IbanDetector implements Detector {
  readonly name = 'iban';
  readonly #validator: Validator;

  constructor(options: { validator?: Validator } = {}) {
    this.#validator = options.validator ?? isValidIban;
  }

  detect(text: string): Entity[] {
    const entities: Entity[] = [];
    for (const { value: candidate, offset } of matchAll(PATTERN, text)) {
      const value = this.#longestValidPrefix(candidate);
      if (value !== null) {
        entities.push(createEntity({ type: EntityType.Iban, value, offset, confidence: 1, detector: 'iban' }));
      }
    }

    return entities;
  }

  /**
   * The greedy pattern may swallow a following uppercase token ("... 3201 BIC"), also from the next line.
   * Drop trailing whitespace-separated groups until the checksum matches.
   */
  #longestValidPrefix(candidate: string): string | null {
    for (;;) {
      if (this.#validator(candidate)) {
        return candidate;
      }
      const shorter = LAST_GROUP.exec(candidate)?.[1];
      if (shorter === undefined) {
        return null;
      }
      candidate = shorter;
    }
  }
}
