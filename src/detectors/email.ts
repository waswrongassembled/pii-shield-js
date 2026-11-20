import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { matchAll, WORD_CHARS, WORD_END } from '../internal/pcre.js';
import { authorityLine, isAuthorityContact, isAuthorityEmail } from './authority-context.js';

const PATTERN = new RegExp(
  String.raw`(?<![${WORD_CHARS}.%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}${WORD_END}`,
  'gu',
);

export interface ContactDetectorOptions {
  /**
   * Keep the sender authority's own contact details (default true): they are needed for the action steps
   * and are not the recipient's personal data. See the heuristic in authority-context.ts.
   */
  keepAuthorityContacts?: boolean;
}

export class EmailDetector implements Detector {
  readonly name = 'email';
  readonly #keepAuthorityContacts: boolean;

  constructor(options: ContactDetectorOptions = {}) {
    this.#keepAuthorityContacts = options.keepAuthorityContacts ?? true;
  }

  detect(text: string): Entity[] {
    const entities: Entity[] = [];
    let authority: string | null | undefined;
    for (const { value, offset } of matchAll(PATTERN, text)) {
      if (this.#keepAuthorityContacts) {
        if (isAuthorityContact(text, offset)) {
          continue;
        }
        authority ??= authorityLine(text);
        if (isAuthorityEmail(text, value, authority)) {
          continue;
        }
      }
      entities.push(createEntity({ type: EntityType.Email, value, offset, confidence: 1, detector: 'email' }));
    }

    return entities;
  }
}
