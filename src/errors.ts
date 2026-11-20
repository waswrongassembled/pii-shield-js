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

export type LearningErrorCode = 'LEARNING_FAILED' | 'LEARNING_PLAIN_WORDS';

/**
 * A custom entity type could not be learned or loaded; the message says why and how to fix it
 * (PHP's LearningFailedException). `LEARNING_PLAIN_WORDS` (PHP code 1): the examples are plain words,
 * which cannot become a safe pattern. Messages name positions, never example values.
 */
export class LearningError extends PiiShieldError {
  declare readonly code: LearningErrorCode;

  constructor(message: string, code: LearningErrorCode = 'LEARNING_FAILED', options?: ErrorOptions) {
    super(message, code, options);
  }
}
