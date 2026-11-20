/**
 * The kinds of personal data. The values appear in placeholders (`⟦IBAN_1⟧`) and are identical to the PHP package.
 */
export const EntityType = Object.freeze({
  Person: 'PERSON',
  Address: 'ADDRESS',
  AtSvnr: 'SVNR',
  Iban: 'IBAN',
  TaxNumber: 'TAX_NUMBER',
  FileNumber: 'FILE_NUMBER',
  Email: 'EMAIL',
  Phone: 'PHONE',
  BirthDate: 'BIRTH_DATE',
  LicensePlate: 'LICENSE_PLATE',
  // Mainly found by model-based detection (any country, any format).
  IdNumber: 'ID_NUMBER',
  CreditCard: 'CREDIT_CARD',
  IpAddress: 'IP_ADDRESS',
  Health: 'HEALTH',
  Other: 'OTHER',
} as const);

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

/** All entity type values, in declaration order. */
export const ENTITY_TYPES: readonly EntityType[] = Object.freeze(Object.values(EntityType));

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}
