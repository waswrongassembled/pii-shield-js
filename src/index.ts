/**
 * @waswrongassembled/pii-shield: reversible PII redaction, wire-compatible with clarifile/pii-shield (PHP).
 *
 * The public API is ported phase by phase, see docs/PLAN.md.
 */
export {
  type AsyncDetector,
  type DetectOptions,
  type Detector,
  type DetectorFunction,
  isAsyncDetector,
  type Validator,
} from './detector.js';
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
export {
  DetectionError,
  type DetectionErrorCode,
  LearningError,
  type LearningErrorCode,
  PiiShieldError,
  VaultError,
  type VaultErrorCode,
} from './errors.js';
export { CustomEntityDetector, LearnedTypesDetector } from './learning/custom-entity-detector.js';
export {
  CUSTOM_ENTITY_TYPE_LIMITS,
  type CustomEntityType,
  customEntityTypeFromJSON,
  type CustomEntityTypeInit,
  defineCustomEntityType,
} from './learning/custom-entity-type.js';
export { EntityLearner, type EntityLearnerOptions, type LearningResult } from './learning/entity-learner.js';
export { JsonFileCustomEntityStore, type JsonFileCustomEntityStoreOptions } from './learning/json-file-store.js';
export { patternViolation } from './learning/pattern-grammar.js';
export { learnPattern } from './learning/pattern-learner.js';
export {
  type CustomEntityStore,
  InMemoryCustomEntityStore,
  KeyValueCustomEntityStore,
  type KeyValueCustomEntityStoreOptions,
  type KeyValueStore,
} from './learning/store.js';
export {
  type DetectionModel,
  type ModelCallOptions,
  ModelDetector,
  type ModelDetectorOptions,
  type ModelFunction,
  ModelLocation,
  type ModelPrompt,
} from './model/model-detector.js';
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
