import type { Entity } from '../entity.js';

/** Irreversible replacement text for an entity. A plain function `(entity) => string` works wherever a strategy is accepted. */
export interface MaskingStrategy {
  mask(entity: Entity): string;
}

export type MaskingFunction = (entity: Entity) => string;

/** Irreversible masking for logs, debug output and previews. Use a Redactor for text that goes to a model provider. */
export interface Masker {
  mask(text: string): string;
}
