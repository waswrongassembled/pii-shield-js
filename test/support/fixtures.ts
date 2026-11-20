import { readFileSync } from 'node:fs';

/**
 * Typed access to fixtures/*.json, written by compat/export-fixtures.php from the PHP package.
 * Offsets and lengths are code points, as PHP counts them; Node uses UTF-16 indices (docs/DEVIATIONS.md).
 * Compare with toUtf16Offset().
 */

export interface FixtureEntity {
  type: string;
  label: string | null;
  value: string;
  offset: number;
  length: number;
  confidence: number;
  detector: string;
}

export interface FixtureRedaction {
  redactedText: string;
  vault: Record<string, string>;
  entities: FixtureEntity[];
}

export interface FixtureError {
  class: string;
  code: number;
  message: string;
}

/** Outcome of a PHP call: either a result or the exception it threw. */
export type Outcome<T> = { result: T; error?: never } | { error: FixtureError; result?: never };

export interface FixtureMeta {
  generatedBy: string;
  phpSource: string;
}

export interface CustomEntityTypeData {
  name: string;
  description: string;
  examples: string[];
  counterExamples: string[];
  pattern: string | null;
}

export interface Described {
  class: string;
  options: Record<string, string | number | boolean>;
}

export interface ValidatorsFixture extends FixtureMeta {
  validators: Record<string, { case: string; input: string; valid: boolean }[]>;
}

export interface DetectorsFixture extends FixtureMeta {
  cases: { case: string; detector: Described; text: string; entities: FixtureEntity[] }[];
}

export interface RedactionFixture extends FixtureMeta {
  cases: { case: string; text: string; redaction: FixtureRedaction; mask: string }[];
  configured: {
    case: string;
    allowlist: string[];
    customTypes: CustomEntityTypeData[];
    text: string;
    redaction: FixtureRedaction;
    mask: string;
  }[];
  restore: {
    vault: Record<string, string>;
    cases: {
      case: string;
      text: string;
      placeholders: { canonical: string; original: string }[];
      restored: string;
      unknownPlaceholders: string[];
      unusedPlaceholders: string[];
      isClean: boolean;
    }[];
  };
}

export interface LettersFixture extends FixtureMeta {
  letters: {
    name: string;
    text: string;
    expected: {
      pii: { type: string; value: string }[];
      must_survive: string[];
      negative: { value: string; reason: string }[];
      detection?: string;
    };
    redaction: FixtureRedaction;
    restored: string;
    mask: string;
  }[];
}

export interface MaskingFixture extends FixtureMeta {
  partialMask: { case: string; strategy: Described; value: string; masked: string }[];
  partialMaskNegative: Outcome<never>;
  typeLabelMask: { format: string; type: string; masked: string }[];
  masker: { case: string; text: string; masked: string }[];
}

export interface LearningFixture extends FixtureMeta {
  patternLearner: ({ case: string; examples: string[]; counterExamples: string[] } & Outcome<string>)[];
  customEntityType: ({ case: string; input: CustomEntityTypeData } & Outcome<CustomEntityTypeData>)[];
  fromArray: ({ case: string; input: Record<string, unknown> } & Outcome<CustomEntityTypeData>)[];
  grammar: {
    probes: string[];
    cases: { pattern: string; violation: string | null; compiles: boolean; fullMatches: string[] | null }[];
  };
  preview: ({ case: string; input: CustomEntityTypeData } & Outcome<{
    type: CustomEntityTypeData;
    note: string | null;
  }>)[];
  jsonStore: {
    steps: { learn: [string, string, string[], string[], string | null] }[];
    file: string;
    afterForget: { forget: string; file: string };
    detect: { text: string; entities: FixtureEntity[] };
  };
}

export interface VaultFixture extends FixtureMeta {
  note: string;
  key: string;
  payloads: { case: string; id: string; mapping: Record<string, string>; plaintext: string; payload: string }[];
  failures: ({ case: string; id: string; payload: string; key?: string } & Outcome<Record<string, string> | null>)[];
  keyLength: Outcome<never>;
  ttl: Outcome<never>;
}

interface FixtureFiles {
  validators: ValidatorsFixture;
  detectors: DetectorsFixture;
  redaction: RedactionFixture;
  letters: LettersFixture;
  masking: MaskingFixture;
  learning: LearningFixture;
  vault: VaultFixture;
}

export const FIXTURE_NAMES = [
  'validators',
  'detectors',
  'redaction',
  'letters',
  'masking',
  'learning',
  'vault',
] as const satisfies readonly (keyof FixtureFiles)[];

export function loadFixture<K extends keyof FixtureFiles>(name: K): FixtureFiles[K] {
  const url = new URL(`../../fixtures/${name}.json`, import.meta.url);

  return JSON.parse(readFileSync(url, 'utf8')) as FixtureFiles[K];
}

/** Substring by code point offset and length, the way PHP's mb_substr() counts. */
export function codePointSlice(text: string, offset: number, length: number): string {
  return [...text].slice(offset, offset + length).join('');
}

/** PHP's code point offset converted to the UTF-16 index that the TypeScript port reports. */
export function toUtf16Offset(text: string, codePointOffset: number): number {
  return [...text].slice(0, codePointOffset).join('').length;
}

/** A fixture entity as the TypeScript port reports it: UTF-16 offset, no length, label only when set. */
export function expectedEntity(text: string, e: FixtureEntity): Record<string, unknown> {
  return {
    type: e.type,
    value: e.value,
    offset: toUtf16Offset(text, e.offset),
    confidence: e.confidence,
    detector: e.detector,
    ...(e.label === null ? {} : { label: e.label }),
  };
}
