import type { DetectOptions } from './detector.js';
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
 * `PiiShield.redactToVault()` returns a VaultRedactionResult, which adds the `vaultId`.
 */
export interface RedactionResult {
  readonly redactedText: string;
  readonly mapping: PlaceholderMapping;
  /** All detected entities (offsets into the original text), for diagnostics and tests. */
  readonly entities: readonly Entity[];
}

/** Result of `PiiShield.redactToVault()`: the mapping is also stored in the vault under `vaultId`. */
export interface VaultRedactionResult extends RedactionResult {
  /** 32 lowercase hex characters (16 random bytes). Pass it to restoreFromVault() and forget(). */
  readonly vaultId: string;
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
  /** Like redact(), also with async detectors (model-based detection). */
  redactAsync(text: string, options?: DetectOptions): Promise<RedactionResult>;
  /** Replaces placeholders in a (model-generated) text with the original values. */
  restore(text: string, source: RedactionResult | PlaceholderMapping): RestoreResult;
}

/**
 * Unmasking across requests (PHP's VaultAwarePiiShieldInterface): the mapping is stored in a vault, a later
 * request restores by id.
 */
export interface VaultRedactor extends Redactor {
  /** Redacts like redactAsync() and stores the mapping in the vault under a new random id. */
  redactToVault(text: string, options?: DetectOptions): Promise<VaultRedactionResult>;
  /**
   * @throws VaultError if the id is unknown or expired, or the entry cannot be read
   * @throws Error if no vault is configured
   */
  restoreFromVault(text: string, vaultId: string): Promise<RestoreResult>;
  /**
   * Deletes the mapping immediately (end of conversation, right to erasure).
   *
   * @throws Error if no vault is configured
   */
  forget(vaultId: string): Promise<void>;
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

/** @internal */
export function withVaultId(result: RedactionResult, vaultId: string): VaultRedactionResult {
  const { redactedText, mapping, entities } = result;
  const withId = { redactedText, mapping, entities, vaultId };
  Object.defineProperty(withId, INSPECT, {
    value: () => ({ redactedText, mapping: '[hidden]', entityCount: entities.length, vaultId }),
  });

  return Object.freeze(withId);
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
