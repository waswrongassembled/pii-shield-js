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
export { isValidAtSvnr } from './validators/at-svnr.js';
export { isValidDeTaxId } from './validators/de-tax-id.js';
export { isValidIban } from './validators/iban.js';
