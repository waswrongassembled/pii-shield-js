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

/** A candidate check, e.g. a checksum. */
export type Validator = (candidate: string) => boolean;
