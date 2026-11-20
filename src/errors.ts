/**
 * Base class of every error pii-shield throws for a runtime condition (PHP's ExceptionInterface):
 * catch this to handle any of them. Messages never contain personal data or key material.
 *
 * Invalid arguments (a bad TTL, a key of the wrong length) throw the built-in `TypeError` / `RangeError`.
 */
export class PiiShieldError extends Error {
  /** Stable, machine-readable error code. */
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export type VaultErrorCode = 'VAULT_DECRYPTION_FAILED' | 'VAULT_CORRUPT' | 'VAULT_UNKNOWN_ID';

/** Stored vault data could not be read, or the vault id is unknown (PHP's VaultException). */
export class VaultError extends PiiShieldError {
  declare readonly code: VaultErrorCode;

  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- narrows `code` to VaultErrorCode
  constructor(message: string, code: VaultErrorCode, options?: ErrorOptions) {
    super(message, code, options);
  }
}
