import type { Entity } from './entity.js';
import type { EntityType } from './entity-type.js';
import { replacePlaceholders } from './placeholder.js';

/**
 * Placeholder → original value, e.g. `{ '⟦PERSON_1⟧': 'Maria Muster' }`, in order of assignment.
 * A plain object, so it serializes as the JSON object the PHP package stores in its vault.
 */
export type PlaceholderMapping = Readonly<Record<string, string>>;

/**
 * Result of a redaction. Holds the original values: never log it, persist it or send it to a model provider
 * (send `redactedText` only).
 *
 * A frozen plain object. `JSON.stringify` includes the mapping (it is the data you restore from);
 * only `util.inspect` / `console.log` in Node hide it, like PHP's `__debugInfo()`.
 *
 * Phase 6 adds vault-backed redaction, whose result extends this type with a `vaultId`.
 */
export interface RedactionResult {
  readonly redactedText: string;
  readonly mapping: PlaceholderMapping;
  /** All detected entities (offsets into the original text), for diagnostics and tests. */
  readonly entities: readonly Entity[];
}

export interface RestoreResult {
  readonly text: string;
  /** Placeholders found in the text that are not in the mapping (the model invented them), in order of appearance. */
  readonly unknownPlaceholders: readonly string[];
  /** Mapping entries that did not appear in the text (informational), in mapping order. */
  readonly unusedPlaceholders: readonly string[];
  /** True when there are no unknown placeholders. */
  readonly isClean: boolean;
}

/** Reversible redaction (PHP's PiiShieldInterface). */
export interface Redactor {
  /** Replaces detected personal data with consistent, typed placeholders. */
  redact(text: string): RedactionResult;
  /** Replaces placeholders in a (model-generated) text with the original values. */
  restore(text: string, source: RedactionResult | PlaceholderMapping): RestoreResult;
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/** @internal */
export function createRedactionResult(
  redactedText: string,
  mapping: Record<string, string>,
  entities: Entity[],
): RedactionResult {
  const result = { redactedText, mapping: Object.freeze(mapping), entities: Object.freeze(entities) };
  Object.defineProperty(result, INSPECT, {
    value: () => ({ redactedText, mapping: '[hidden]', entityCount: entities.length }),
  });

  return Object.freeze(result);
}

/**
 * Replaces placeholders (tolerant to model mangling, see replacePlaceholders()) with their original values.
 * Placeholders that are not in the mapping stay as they were found.
 */
export function restorePlaceholders(text: string, source: RedactionResult | PlaceholderMapping): RestoreResult {
  const mapping = isRedactionResult(source) ? source.mapping : source;
  const seen = new Set<string>();
  const unknown = new Set<string>();

  const restored = replacePlaceholders(text, (canonical, original) => {
    const value = Object.hasOwn(mapping, canonical) ? mapping[canonical] : undefined;
    if (value === undefined) {
      unknown.add(canonical);

      return original;
    }
    seen.add(canonical);

    return value;
  });

  return Object.freeze({
    text: restored,
    unknownPlaceholders: Object.freeze([...unknown]),
    unusedPlaceholders: Object.freeze(Object.keys(mapping).filter((placeholder) => !seen.has(placeholder))),
    isClean: unknown.size === 0,
  });
}

/** The distinct entity types of a redaction, in order of first appearance (PHP's foundTypes()). */
export function foundTypes(result: Pick<RedactionResult, 'entities'>): EntityType[] {
  return [...new Set(result.entities.map((e) => e.type))];
}

function isRedactionResult(source: RedactionResult | PlaceholderMapping): source is RedactionResult {
  // A mapping only holds strings, so an object-valued "mapping" property marks a RedactionResult.
  const mapping: unknown = (source as Partial<RedactionResult>).mapping;

  return typeof mapping === 'object' && mapping !== null;
}
