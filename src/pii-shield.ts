import { type Entity, typeName } from './entity.js';
import { EntityExtractor, type EntityExtractorOptions, surname } from './entity-extractor.js';
import { EntityType } from './entity-type.js';
import { VaultError } from './errors.js';
import { replaceSpans } from './internal/text-spans.js';
import { formatPlaceholder } from './placeholder.js';
import {
  createRedactionResult,
  type PlaceholderMapping,
  type RedactionResult,
  type Redactor,
  restorePlaceholders,
  type RestoreResult,
  type VaultRedactionResult,
  type VaultRedactor,
  withVaultId,
} from './redaction.js';
import { assertTtl, type Vault } from './vault/vault.js';

export interface PiiShieldOptions extends EntityExtractorOptions {
  /** Optional; enables redactToVault(), restoreFromVault() and forget() across requests. */
  vault?: Vault;
  /** Seconds a stored mapping lives, a positive integer. Default: PiiShield.DEFAULT_VAULT_TTL (3600). */
  vaultTtl?: number;
}

/**
 * Replaces each detected entity with a consistent, typed placeholder (see EntityExtractor for detection rules).
 *
 * - Consistency: the same value always gets the same placeholder within one text.
 * - Person aliases: a surname that also occurs as last part of a full name maps to the
 *   full name's placeholder. Restore yields the full name.
 */
export class PiiShield implements VaultRedactor {
  static readonly DEFAULT_VAULT_TTL = 3600;

  readonly #extractor: EntityExtractor;
  readonly #vault: Vault | undefined;
  readonly #vaultTtl: number;

  constructor(options: PiiShieldOptions = {}) {
    const { detectors, allowlist, vault, vaultTtl = PiiShield.DEFAULT_VAULT_TTL } = options;
    assertTtl(vaultTtl, 'The vault TTL must be positive.');
    this.#vault = vault;
    this.#vaultTtl = vaultTtl;
    this.#extractor = new EntityExtractor({
      ...(detectors === undefined ? {} : { detectors }),
      ...(allowlist === undefined ? {} : { allowlist }),
    });
  }

  redact(text: string): RedactionResult {
    const entities = this.#extractor.extract(text);
    if (entities.length === 0) {
      return createRedactionResult(text, {}, entities);
    }

    const { mapping, byValue } = assignPlaceholders(entities);
    const redacted = replaceSpans(text, entities, (e) => byValue.get(typeName(e))?.get(e.value) ?? e.value);

    return createRedactionResult(redacted, mapping, entities);
  }

  restore(text: string, source: RedactionResult | PlaceholderMapping): RestoreResult {
    return restorePlaceholders(text, source);
  }

  async redactToVault(text: string): Promise<VaultRedactionResult> {
    const vault = this.#requireVault();
    const result = this.redact(text);
    const vaultId = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString('hex');
    await vault.store(vaultId, result.mapping, this.#vaultTtl);

    return withVaultId(result, vaultId);
  }

  async restoreFromVault(text: string, vaultId: string): Promise<RestoreResult> {
    const mapping = await this.#requireVault().fetch(vaultId);
    if (mapping === null) {
      throw new VaultError('Unknown or expired vault id.', 'VAULT_UNKNOWN_ID');
    }

    return restorePlaceholders(text, mapping);
  }

  async forget(vaultId: string): Promise<void> {
    await this.#requireVault().delete(vaultId);
  }

  #requireVault(): Vault {
    if (this.#vault === undefined) {
      throw new Error('No vault configured. Pass a Vault to PiiShield to restore across requests.');
    }

    return this.#vault;
  }
}

/**
 * Pass-through implementation, e.g. to build an app before the real shield is wired up. Redacts nothing.
 */
export class NullPiiShield implements Redactor {
  redact(text: string): RedactionResult {
    return createRedactionResult(text, {}, []);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- same signature as Redactor
  restore(text: string, source?: RedactionResult | PlaceholderMapping): RestoreResult {
    return Object.freeze({
      text,
      unknownPlaceholders: Object.freeze([]),
      unusedPlaceholders: Object.freeze([]),
      isClean: true,
    });
  }
}

/**
 * Numbers placeholders per type name in order of appearance. Full names come first, so a surname
 * that appears before its full name still links to it.
 *
 * @param entities sorted by offset
 */
function assignPlaceholders(entities: readonly Entity[]): {
  mapping: Record<string, string>;
  byValue: Map<string, Map<string, string>>;
} {
  const mapping: Record<string, string> = {};
  // type name → value → placeholder
  const byValue = new Map<string, Map<string, string>>();
  const counters = new Map<string, number>();

  const fullNames = entities.filter((e) => e.type === EntityType.Person && surname(e.value) !== null);
  for (const entity of [...fullNames, ...entities]) {
    const type = typeName(entity);
    let placeholders = byValue.get(type);
    if (placeholders === undefined) {
      placeholders = new Map();
      byValue.set(type, placeholders);
    }
    if (placeholders.has(entity.value)) {
      continue;
    }

    if (entity.type === EntityType.Person && surname(entity.value) === null) {
      const alias = fullNameFor(entity.value, placeholders);
      if (alias !== null) {
        placeholders.set(entity.value, alias);
        continue;
      }
    }

    const counter = (counters.get(type) ?? 0) + 1;
    counters.set(type, counter);
    const placeholder = formatPlaceholder(type, counter);
    placeholders.set(entity.value, placeholder);
    mapping[placeholder] = entity.value;
  }

  return { mapping, byValue };
}

/** The placeholder of the first full name (in assignment order) whose surname is `name`. */
function fullNameFor(name: string, placeholders: ReadonlyMap<string, string>): string | null {
  for (const [fullName, placeholder] of placeholders) {
    if (surname(fullName) === name) {
      return placeholder;
    }
  }

  return null;
}
