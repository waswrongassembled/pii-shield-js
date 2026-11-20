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

export type DetectionErrorCode = 'DETECTION_MODEL_UNREACHABLE' | 'DETECTION_INVALID_ANSWER' | 'DETECTION_TEXT_TOO_LONG';

/**
 * Model-based detection failed and must not continue: going on without the model's findings could let
 * personal data through unredacted (PHP's DetectionFailedException). The message never contains the text.
 *
 * - `DETECTION_MODEL_UNREACHABLE`: the model call failed or timed out. The error is the `cause`; keep it
 *   to server logs, providers may echo the request (the unredacted text) in their messages.
 * - `DETECTION_INVALID_ANSWER`: the model's answer was unusable twice; `modelAnswer` holds it.
 * - `DETECTION_TEXT_TOO_LONG`: the text needs more chunks than the model detector sends.
 */
export class DetectionError extends PiiShieldError {
  declare readonly code: DetectionErrorCode;
  /**
   * The model's answer, for debugging only: it may contain personal data. Not enumerable, so
   * `console.log(error)` and `JSON.stringify(error)` leave it out.
   */
  declare readonly modelAnswer?: string;

  constructor(message: string, code: DetectionErrorCode, options?: ErrorOptions & { modelAnswer?: string }) {
    super(message, code, options);
    if (options?.modelAnswer !== undefined) {
      Object.defineProperty(this, 'modelAnswer', { value: options.modelAnswer, enumerable: false });
    }
  }
}
