import type { Detector } from '../detector.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { LINE_END, LINE_START, matchAll, WORD_START } from '../internal/pcre.js';

const TITLES = String.raw`(?:(?:Dr|Mag|DI|Dipl\.-Ing|Ing|Prof|MMag|Mag\.\(FH\))\.?[ \t]+)*`;
const WORD = String.raw`\p{Lu}[\p{L}'\-]+`;
/** Like WORD, but also an initial split off by OCR: "J ohann". */
const OCR_WORD = String.raw`\p{Lu}(?:[ \t](?=\p{Ll}))?[\p{L}'\-]+`;

const BLOCK = new RegExp(
  String.raw`${LINE_START}(?:Herrn?|Frau)[ \t]*\n(?:[ \t]*\n){0,2}${TITLES}(?<name>${OCR_WORD}(?:[ \t]+${WORD})+)[ \t]*${LINE_END}`,
  'dgu',
);
const INLINE = new RegExp(
  String.raw`${WORD_START}(?:Herrn?|Frau)[ \t]+${TITLES}(?<name>${WORD}(?:[ \t]+${WORD})?)`,
  'dgu',
);

/**
 * Offline fallback for person names: names following "Herr", "Herrn" or "Frau".
 *
 * - Address block: salutation alone on a line, name on the next non-empty line ("Frau\nMaria Musterfrau").
 *   Tolerates OCR output: up to two blank lines in between and a split first word ("J ohann").
 * - Inline: "Sehr geehrter Herr Beispielmann", up to two capitalised words. A following German
 *   noun ("Herr Muster Bescheid") is indistinguishable from a surname without NER; over-redaction
 *   is preferred to leaking half a name.
 *
 * Academic titles are skipped and not part of the value. Names without salutation
 * (e.g. the signing official) are left to the NER detector.
 */
export class SalutationPersonDetector implements Detector {
  readonly name = 'salutation_person';

  detect(text: string): Entity[] {
    // The address block is a strong signal; inline matches may include a following noun.
    const entities: Entity[] = [];
    for (const [pattern, confidence, detector] of [
      [BLOCK, 0.8, 'salutation_block'],
      [INLINE, 0.6, 'salutation_inline'],
    ] as const) {
      for (const { value, offset } of matchAll(pattern, text, 'name')) {
        entities.push(createEntity({ type: EntityType.Person, value, offset, confidence, detector }));
      }
    }

    return entities.sort((a, b) => a.offset - b.offset);
  }
}
