import type { Entity } from './entity.js';

/**
 * Finds personal data in a text. Offsets of the returned entities are UTF-16 indices into `text`.
 * A plain function `(text) => Entity[]` works wherever a detector is accepted.
 */
export interface Detector {
  /** Informational name, e.g. for logs. */
  readonly name?: string;
  detect(text: string): readonly Entity[];
}

export type DetectorFunction = (text: string) => readonly Entity[];

export interface DetectOptions {
  /** Cancels the detection; the returned Promise rejects with the signal's reason. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * A detector that needs I/O, e.g. ModelDetector. `async: true` marks it, so the synchronous APIs
 * (`extract()`, `redact()`, `mask()`) can refuse it before anything is sent; use `extractAsync()`,
 * `redactAsync()`, `redactToVault()` or `maskAsync()` instead.
 */
export interface AsyncDetector {
  readonly name?: string;
  readonly async: true;
  detect(text: string, options?: DetectOptions): Promise<readonly Entity[]>;
}

export function isAsyncDetector(detector: unknown): detector is AsyncDetector {
  return typeof detector === 'object' && detector !== null && (detector as { async?: unknown }).async === true;
}

/** A candidate check, e.g. a checksum. */
export type Validator = (candidate: string) => boolean;
