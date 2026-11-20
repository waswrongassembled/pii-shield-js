import type { EntityType } from './entity-type.js';

/**
 * A detected span of personal data in the original text.
 *
 * - `offset` is a UTF-16 index, so `text.slice(offset, offset + value.length) === value`
 *   (PHP counts code points; see docs/DEVIATIONS.md).
 * - `label` is only present for learned types, which use `EntityType.Other` with their own name
 *   (e.g. "INSURANCE_NUMBER"). Built-in detectors never set it; PHP's `null` maps to an absent property.
 */
export interface Entity {
  readonly type: EntityType;
  readonly value: string;
  readonly offset: number;
  readonly confidence: number;
  readonly detector: string;
  readonly label?: string;
}

/** Creates an entity; `confidence` defaults to 1 and `detector` to "unknown", as in PHP. */
export function createEntity(init: {
  type: EntityType;
  value: string;
  offset: number;
  confidence?: number;
  detector?: string;
  label?: string | null | undefined;
}): Entity {
  const { type, value, offset, confidence = 1, detector = 'unknown', label } = init;

  return label === undefined || label === null
    ? { type, value, offset, confidence, detector }
    : { type, value, offset, confidence, detector, label };
}

/** Name used in placeholders and masks: the custom label of a learned type, otherwise the type. */
export function typeName(entity: Entity): string {
  return entity.label ?? entity.type;
}
