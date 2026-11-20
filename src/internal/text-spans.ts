import type { Entity } from '../entity.js';

/**
 * Replaces entity spans in one pass (PHP's TextSpans). Offsets are UTF-16 indices.
 *
 * @param entities sorted by offset, not overlapping (as EntityExtractor returns them)
 * @internal
 */
export function replaceSpans(
  text: string,
  entities: readonly Entity[],
  replacement: (entity: Entity) => string,
): string {
  let result = '';
  let cursor = 0;
  for (const entity of entities) {
    result += text.slice(cursor, entity.offset) + replacement(entity);
    cursor = entity.offset + entity.value.length;
  }

  return result + text.slice(cursor);
}
