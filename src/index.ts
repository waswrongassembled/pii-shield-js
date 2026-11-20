/**
 * @waswrongassembled/pii-shield: reversible PII redaction, wire-compatible with clarifile/pii-shield (PHP).
 *
 * The public API is ported phase by phase, see docs/PLAN.md.
 */
export type { Detector, DetectorFunction, Validator } from './detector.js';
export { AtSvnrDetector } from './detectors/at-svnr.js';
export { BirthDateDetector } from './detectors/birth-date.js';
export { EmailDetector, type ContactDetectorOptions } from './detectors/email.js';
export { FileNumberDetector } from './detectors/file-number.js';
export { IbanDetector } from './detectors/iban.js';
export { LicensePlateDetector } from './detectors/license-plate.js';
export { PhoneDetector } from './detectors/phone.js';
export { PostalAddressDetector } from './detectors/postal-address.js';
export { SalutationPersonDetector } from './detectors/salutation-person.js';
export { TaxNumberDetector } from './detectors/tax-number.js';
export { createEntity, typeName, type Entity } from './entity.js';
export { defaultDetectors, EntityExtractor, surname, type EntityExtractorOptions } from './entity-extractor.js';
export { ENTITY_TYPES, EntityType, isEntityType } from './entity-type.js';
export { PiiShieldError, VaultError, type VaultErrorCode } from './errors.js';
export { PartialMask, type PartialMaskOptions } from './masking/partial-mask.js';
export type { Masker, MaskingFunction, MaskingStrategy } from './masking/strategy.js';
export { TypeLabelMask, type TypeLabelMaskOptions } from './masking/type-label-mask.js';
export { defaultMaskingStrategies, PiiMasker, type PiiMaskerOptions } from './pii-masker.js';
export { NullPiiShield, PiiShield, type PiiShieldOptions } from './pii-shield.js';
export { formatPlaceholder, replacePlaceholders } from './placeholder.js';
export {
  foundTypes,
  type PlaceholderMapping,
  type RedactionResult,
  type Redactor,
  restorePlaceholders,
  type RestoreResult,
  type VaultRedactionResult,
  type VaultRedactor,
} from './redaction.js';
export { isValidAtSvnr } from './validators/at-svnr.js';
export { isValidDeTaxId } from './validators/de-tax-id.js';
export { isValidIban } from './validators/iban.js';
export {
  EncryptedVault,
  type EncryptedVaultOptions,
  generateVaultKey,
  parseVaultKey,
} from './vault/encrypted-vault.js';
export { InMemoryVault, type InMemoryVaultOptions } from './vault/in-memory-vault.js';
export { MemoryVaultStorage, type MemoryVaultStorageOptions } from './vault/memory-vault-storage.js';
export type { Clock, Vault, VaultStorage } from './vault/vault.js';
