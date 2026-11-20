import type { AsyncDetector, DetectOptions } from '../detector.js';
import {
  authorityLine,
  isAuthorityContact,
  isAuthorityEmail,
  isInLetterhead,
  isMobileNumber,
} from '../detectors/authority-context.js';
import { FILE_NUMBER_KEYWORDS } from '../detectors/file-number.js';
import { createEntity, type Entity } from '../entity.js';
import { EntityType } from '../entity-type.js';
import { DetectionError } from '../errors.js';
import { codePointLength, phpTrim, SPACE, SPACE_CHARS, WORD, WORD_START } from '../internal/pcre.js';
import type { CustomEntityType } from '../learning/custom-entity-type.js';
import { EntityLearner } from '../learning/entity-learner.js';
import type { CustomEntityStore } from '../learning/store.js';
import { chunks, MAX_CHUNKS } from './chunks.js';
import { type Finding, instructions, parseAnswer, withoutReasoning } from './prompt.js';

/**
 * Where the detection model runs (PHP's ModelLocation, same values). Detection necessarily sends the
 * unredacted text to the model, so this decides whether personal data leaves your infrastructure.
 *
 * - `local`: the same machine, e.g. Ollama on localhost.
 * - `on_premise`: your own infrastructure, e.g. a GPU server running Ollama or vLLM.
 * - `external`: a third-party provider (OpenAI, Anthropic, Mistral, ...). Needs a data processing
 *   agreement, possibly a third-country transfer; requires `acknowledgeExternalTransfer: true`.
 */
export const ModelLocation = Object.freeze({
  Local: 'local',
  OnPremise: 'on_premise',
  External: 'external',
} as const);

export type ModelLocation = (typeof ModelLocation)[keyof typeof ModelLocation];

/** The two messages of one model call: the instructions and a chunk of the unredacted text. */
export interface ModelPrompt {
  readonly system: string;
  readonly user: string;
}

export interface ModelCallOptions {
  /** Aborted when the caller cancels, the timeout passes or another chunk of the same text failed. */
  readonly signal: AbortSignal;
}

/**
 * Calls a model and returns its text answer. Wrap any provider SDK in it; for the Vercel AI SDK use
 * `detectionModel()` from `@waswrongassembled/pii-shield/ai-sdk`.
 */
export type ModelFunction = (prompt: ModelPrompt, options: ModelCallOptions) => Promise<string>;

/** A model function with the name used in error messages (e.g. "llama3.1:8b"). */
export interface DetectionModel {
  readonly name: string;
  readonly generate: ModelFunction;
}

export interface ModelDetectorOptions {
  /** The model: a function, or a DetectionModel to name it in error messages. */
  model: ModelFunction | DetectionModel;
  /** Where the model runs; required, because detection sends the unredacted text there. */
  location: ModelLocation;
  /** Required for `location: 'external'` (data processing agreement, possibly a third-country transfer). */
  acknowledgeExternalTransfer?: boolean;
  /**
   * Learned types, taught to the model with their examples (also model-only types without a pattern).
   * A store is read at every detect() call (as in PHP); an EntityLearner gives its snapshot.
   */
  learnedTypes?: CustomEntityStore | EntityLearner | Iterable<CustomEntityType>;
  /** Code points per model call, at least 100. Default ModelDetector.DEFAULT_CHUNK_SIZE (4,000). */
  chunkSize?: number;
  /** Keep the sender authority's contacts (letterhead, "erreichen Sie uns unter ..."). Default true. */
  keepAuthorityContacts?: boolean;
  /** Milliseconds a detect() call may take in total; then it fails with DETECTION_MODEL_UNREACHABLE. */
  timeout?: number;
}

const NAME = 'model';
const CONFIDENCE = 0.85;
const MIN_CHUNK_SIZE = 100;
/** Requests in flight at the same time. */
const CONCURRENCY = 4;

/** A complete date and/or a time (with a colon), nothing else. */
const DATE_OR_TIME =
  /^(?:\p{Nd}{1,2}\.[ ]?\p{Nd}{1,2}\.[ ]?\p{Nd}{2,4}(?:,?[ ]?\p{Nd}{1,2}:\p{Nd}{2}(?:[ ]?Uhr)?)?|\p{Nd}{1,2}:\p{Nd}{2}(?:[ ]?Uhr)?)\n?$/u;
/** A law's abbreviation: one word, at least two capitals, no digits ("StVO", "MusterParkG"). At most 25 code points. */
const LAW_ABBREVIATION = /^(?=(?:\p{L}*\p{Lu}){2})\p{Lu}\p{L}{1,24}\n?$/u;
const POSTCODE_AND_TOWN =
  /^(?:,[ \t]*|[ \t]*\n(?:[ \t]*\n){0,2})(?:(?:A|D|CH)-)?(?:[1-9]\p{Nd}{3}|\p{Nd}{5})[ \t]+\p{Lu}[\p{L}.'-]*(?:[ \t]+\p{Lu}[\p{L}.'-]*)*/u;
const BIRTH_KEYWORDS = new RegExp(
  String.raw`(?:geb\.|geboren|geburt|born|birth|dob|né|née|nato|nata|nacid[oa]|narozen|nar\.|urodzon|rođen|születés|f\.${SPACE}*d\.)`,
  'iu',
);
/** PHP: '/\b'.KEYWORDS.'[ \t]*:?[ \t]*$/u'; the trailing part is stripped first (see keywordBefore()). */
const FILE_NUMBER_KEYWORD_AT_END = new RegExp(`${WORD_START}${FILE_NUMBER_KEYWORDS}$`, 'u');
const CITATION_KEYWORDS = ['Abs', 'lit', 'Z', 'Ziff', 'Satz', 'Nr', 'Art'];
const WORDS_AT = new RegExp(`${WORD}+`, 'uy');
const DIGITS_AT = /\p{Nd}+/uy;
const SPLIT_WORDS = new RegExp(`[${SPACE_CHARS},]+`, 'u');

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Detects personal data with a model of your choice: a local Ollama, an on-premise GPU server or a
 * public provider. Works for any language and country, not only DACH formats. Port of PHP's
 * `ModelDetector`: same prompt, same parsing, same checks.
 *
 * - The model returns type + value; every value is grounded in the original text (whitespace and
 *   commas may differ). Values the model invented are dropped.
 * - Findings are checked in their context with the rules of the pattern detectors (dates, citations,
 *   file number keywords, authority contacts); addresses are extended by the postcode and town that follow.
 * - Long texts go out in overlapping chunks, four at a time. An unusable answer is asked for once more,
 *   then detection fails closed with DetectionError.
 *
 * Async: use it with `PiiShield.redactAsync()`, `redactToVault()`, `PiiMasker.maskAsync()` or
 * `EntityExtractor.extractAsync()`, next to the regex detectors (checksum-validated findings win on overlap).
 * Errors never contain the text; nothing is logged.
 */
export class ModelDetector implements AsyncDetector {
  static readonly DEFAULT_CHUNK_SIZE = 4_000;
  static readonly MAX_CHUNKS = MAX_CHUNKS;

  readonly name = NAME;
  readonly async = true;
  readonly location: ModelLocation;
  readonly #modelName: string;
  readonly #generate: ModelFunction;
  readonly #learnedTypes: ModelDetectorOptions['learnedTypes'];
  readonly #chunkSize: number;
  readonly #keepAuthorityContacts: boolean;
  readonly #timeout: number | undefined;

  /**
   * @throws RangeError for a chunk size below 100 or an invalid timeout
   * @throws TypeError for an empty model name, an unknown location, or an external location without acknowledgement
   */
  constructor(options: ModelDetectorOptions) {
    const {
      model,
      location,
      acknowledgeExternalTransfer = false,
      learnedTypes,
      chunkSize = ModelDetector.DEFAULT_CHUNK_SIZE,
      keepAuthorityContacts = true,
      timeout,
    } = options;
    if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE) {
      throw new RangeError(`The chunk size must be at least ${String(MIN_CHUNK_SIZE)} characters.`);
    }
    if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) {
      throw new RangeError('The timeout must be a positive number of milliseconds.');
    }
    const name = typeof model === 'function' ? model.name || NAME : model.name;
    if (phpTrim(name) === '') {
      throw new TypeError('The model name must not be empty.');
    }
    if (!(Object.values(ModelLocation) as string[]).includes(location)) {
      throw new TypeError(`Unknown model location "${location}": use "local", "on_premise" or "external".`);
    }
    // Only the boolean true counts, also for callers without type checking.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    if (location === ModelLocation.External && acknowledgeExternalTransfer !== true) {
      throw new TypeError(
        'Model-based detection sends the unredacted text to the model. For an external provider, confirm this with acknowledgeExternalTransfer (requires a data processing agreement, possibly a third-country transfer).',
      );
    }
    this.location = location;
    this.#modelName = name;
    this.#generate = typeof model === 'function' ? model : model.generate;
    this.#learnedTypes = learnedTypes;
    this.#chunkSize = chunkSize;
    this.#keepAuthorityContacts = keepAuthorityContacts;
    this.#timeout = timeout;
  }

  /**
   * Entities sorted by offset (UTF-16). Rejects with the signal's reason when the caller aborts.
   *
   * @throws DetectionError
   */
  async detect(text: string, options: DetectOptions = {}): Promise<Entity[]> {
    const { signal: callerSignal } = options;
    callerSignal?.throwIfAborted();
    if (phpTrim(text) === '') {
      return [];
    }

    const learned = await this.#learned();
    // Long texts go out in chunks, CONCURRENCY at a time. One failing chunk fails the detection.
    const parts = chunks(text, this.#chunkSize);
    const system = instructions(learned);
    const signals = [callerSignal, this.#timeout === undefined ? undefined : AbortSignal.timeout(this.#timeout)];
    const signal = AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
    const answers: string[] = [];
    for (let i = 0; i < parts.length; i += CONCURRENCY) {
      answers.push(...(await this.#ask(system, parts.slice(i, i + CONCURRENCY), signal, callerSignal)));
    }

    // Values found in any chunk are grounded in the whole text. An unusable answer (small models
    // sometimes repeat themselves until the answer is cut off) is asked for once more; then fail closed.
    const findings: Finding[] = [];
    for (const [i, answer] of answers.entries()) {
      let parsed = this.#parse(answer, learned, false);
      if (parsed === null) {
        const [again = ''] = await this.#ask(system, [parts[i] ?? ''], signal, callerSignal);
        parsed = this.#parse(again, learned, true) ?? [];
      }
      findings.push(...parsed);
    }

    return this.#ground(text, findings);
  }

  async #learned(): Promise<readonly CustomEntityType[]> {
    const source = this.#learnedTypes;
    if (source === undefined) {
      return [];
    }
    if (source instanceof EntityLearner) {
      return source.snapshot;
    }
    if (isStore(source)) {
      return source.all();
    }

    return [...source];
  }

  /** Sends the chunks concurrently and returns the answers in the same order. */
  async #ask(
    system: string,
    users: readonly string[],
    signal: AbortSignal,
    callerSignal: AbortSignal | undefined,
  ): Promise<string[]> {
    const batch = new AbortController();
    const batchSignal = AbortSignal.any([signal, batch.signal]);
    try {
      return await untilAborted(
        Promise.all(
          users.map(async (user) => {
            const answer: unknown = await this.#generate({ system, user }, { signal: batchSignal });
            if (typeof answer !== 'string') {
              throw new TypeError('The model function must return a string.');
            }

            return answer;
          }),
        ),
        signal,
      );
    } catch (e) {
      batch.abort();
      if (callerSignal?.aborted === true) {
        throw callerSignal.reason;
      }
      // Not the provider's message: it may echo the unredacted request. Details stay in `cause` for server logs.
      throw new DetectionError(
        `The detection model "${this.#modelName}" could not be reached (${errorName(e)}).`,
        'DETECTION_MODEL_UNREACHABLE',
        { cause: e },
      );
    }
  }

  /** The findings of an answer; null if it is unusable and may be asked for again, else DetectionError. */
  #parse(answer: string, learned: readonly CustomEntityType[], last: boolean): Finding[] | null {
    const final = withoutReasoning(answer);
    const findings = parseAnswer(final, learned);
    if (findings === null && last) {
      throw new DetectionError(
        `The detection model "${this.#modelName}" did not return the expected JSON.`,
        'DETECTION_INVALID_ANSWER',
        { modelAnswer: final },
      );
    }

    return findings;
  }

  #ground(text: string, findings: readonly Finding[]): Entity[] {
    const entities: Entity[] = [];
    const seen = new Set<string>();
    const context = new TextContext(text);
    for (const [type, value, label] of findings) {
      const key = `${label ?? type}\0${value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (type === EntityType.Other && DATE_OR_TIME.test(value)) {
        continue; // dates and times must survive; only birth dates are personal (BIRTH_DATE, keyword check)
      }
      if (type === EntityType.FileNumber && !/\p{Nd}/u.test(value)) {
        continue; // document titles such as "ANONYMVERFÜGUNG"
      }
      for (const match of text.matchAll(groundingPattern(value))) {
        if (this.#keepInText(type, match[0], context, match.index)) {
          continue;
        }
        const found = type === EntityType.Address ? withPostcodeAndTown(text, match[0], match.index) : match[0];
        entities.push(
          createEntity({ type, value: found, offset: match.index, confidence: CONFIDENCE, detector: NAME, label }),
        );
      }
    }

    return entities.sort((a, b) => a.offset - b.offset);
  }

  /** The same rules as the pattern detectors, applied to each place a model's finding occurs. */
  #keepInText(type: EntityType, value: string, context: TextContext, offset: number): boolean {
    const { text } = context;
    switch (true) {
      // deadlines and other dates must survive; models confuse them easily
      case type === EntityType.BirthDate:
        return !hasBirthKeywordBefore(text, offset);
      // a law's abbreviation in a citation ("§ 4 Abs. 1 MusterParkG"): the explanation needs it
      case type === EntityType.Other && isLawAbbreviation(value) && isAfterCitation(lineBefore(text, offset)):
        return true;
      // file numbers only after a keyword, like the pattern detector ("Zahl:", "Aktenzeichen", ...)
      case type === EntityType.FileNumber:
        return !isAfterFileNumberKeyword(lineBefore(text, offset));
      case !this.#keepAuthorityContacts:
        return false;
      case type === EntityType.Phone && isMobileNumber(value):
        return false;
      case (type === EntityType.Email || type === EntityType.Phone) && isAuthorityContact(text, offset):
        return true;
      case type === EntityType.Email && isAuthorityEmail(text, value, context.authorityLine):
        return true;
      case type === EntityType.Address || type === EntityType.Email || type === EntityType.Phone:
        return isInLetterhead(text, offset);
      default:
        return false;
    }
  }
}

/** Per-text values computed once. */
class TextContext {
  #authorityLine: string | null | undefined;

  constructor(readonly text: string) {}

  get authorityLine(): string | null {
    this.#authorityLine ??= authorityLine(this.text);

    return this.#authorityLine;
  }
}

function isStore(source: object): source is CustomEntityStore {
  return typeof (source as Partial<CustomEntityStore>).all === 'function';
}

/** PHP reports the exception's class; the TS port its name ("TypeError", "TimeoutError", ...). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Rejects with the signal's reason when it aborts, even if the model function ignores the signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);

    return Promise.reject(signal.reason as Error);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- passes the model's rejection on as is
        reject(error);
      },
    );
  });
}

/** Matches the value as a whole word sequence; whitespace and commas between words may differ. */
function groundingPattern(value: string): RegExp {
  const words = value.split(SPLIT_WORDS).filter((w) => w !== '');
  const body = (words.length === 0 ? [value] : words).map(escapeRegExp).join(`[${SPACE_CHARS},]+`);

  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'gu');
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, String.raw`\$&`);
}

/** The text from the start of the line up to an offset. */
function lineBefore(text: string, offset: number): string {
  return offset === 0 ? '' : text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
}

/** A date counts as a birth date only if a birth keyword appears in the 30 characters (code points) before it. */
function hasBirthKeywordBefore(text: string, offset: number): boolean {
  let start = offset;
  for (let n = 0; n < 30 && start > 0; n++) {
    const low = text.charCodeAt(start - 1);
    const high = text.charCodeAt(start - 2);
    start -= low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
  }

  return BIRTH_KEYWORDS.test(text.slice(start, offset));
}

function isLawAbbreviation(value: string): boolean {
  // The pattern allows at most 25 code points: checking the length first keeps the lookahead linear.
  return codePointLength(value) <= 26 && LAW_ABBREVIATION.test(value);
}

/**
 * PHP: '/§§?[ \t]*\d+[a-z]?(?:[ \t]+(?:Abs|lit|Z|Ziff|Satz|Nr|Art)\.?[ \t]*\w+\)?)*[ \t]+$/u' on the line before.
 *
 * As a regex this backtracks exponentially in JavaScript ("Ziff" is "Z" + "iff" or a keyword of its own,
 * so " Ziff Ziff Ziff ..." has Fibonacci many parses). Each part is otherwise deterministic, so a
 * right-to-left pass decides it in linear time: good[i] says whether the line from i on is a sequence of
 * citation parts followed by blanks up to its end.
 *
 * @internal exported for tests
 */
export function isAfterCitation(before: string): boolean {
  const n = before.length;
  if (n === 0 || !isBlank(before[n - 1])) {
    return false;
  }
  let tail = n;
  while (tail > 0 && isBlank(before[tail - 1])) {
    tail--;
  }
  const good = new Uint8Array(n + 1);
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(before[i])) {
      continue;
    }
    if (i >= tail) {
      good[i] = 1;
      continue;
    }
    const k = skipBlanks(before, i);
    for (const keyword of CITATION_KEYWORDS) {
      if (!before.startsWith(keyword, k)) {
        continue;
      }
      let m = k + keyword.length;
      if (before[m] === '.') {
        m++;
      }
      m = skipBlanks(before, m);
      WORDS_AT.lastIndex = m;
      if (!WORDS_AT.test(before)) {
        continue;
      }
      let end = WORDS_AT.lastIndex;
      if (before[end] === ')') {
        end++;
      }
      if (good[end] === 1) {
        good[i] = 1;
        break;
      }
    }
  }

  for (let p = before.indexOf('§'); p !== -1; p = before.indexOf('§', p + 1)) {
    let q = p + 1;
    if (before[q] === '§') {
      q++;
    }
    DIGITS_AT.lastIndex = skipBlanks(before, q);
    if (!DIGITS_AT.test(before)) {
      continue;
    }
    q = DIGITS_AT.lastIndex;
    if (/[a-z]/.test(before[q] ?? '')) {
      q++;
    }
    if (good[q] === 1) {
      return true;
    }
  }

  return false;
}

/**
 * PHP: '/\b'.KEYWORDS.'[ \t]*:?[ \t]*$/u'; the blanks and the colon are stripped first (linear).
 *
 * @internal exported for tests
 */
export function isAfterFileNumberKeyword(before: string): boolean {
  let end = skipBlanksBackwards(before, before.length);
  if (before[end - 1] === ':') {
    end = skipBlanksBackwards(before, end - 1);
  }

  return FILE_NUMBER_KEYWORD_AT_END.test(before.slice(0, end));
}

/**
 * Models often return only the street of an address ("Gartengasse 5"): add the postcode and town that
 * follow on the same line after a comma, or on the next line (up to two blank lines for OCR text).
 * Like PHP, only the next 120 UTF-8 bytes are looked at; a cut inside a character finds nothing.
 */
function withPostcodeAndTown(text: string, address: string, offset: number): string {
  const end = offset + address.length;
  // 121 UTF-16 units encode to at least 120 bytes; a surrogate pair cut by the slice lies beyond them.
  const bytes = utf8.encode(text.slice(end, end + 121)).subarray(0, 120);
  let rest: string;
  try {
    rest = strictUtf8.decode(bytes);
  } catch {
    return address;
  }
  const match = POSTCODE_AND_TOWN.exec(rest);

  return match === null ? address : address + match[0];
}

function isBlank(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function skipBlanks(text: string, from: number): number {
  let i = from;
  while (isBlank(text[i])) {
    i++;
  }

  return i;
}

function skipBlanksBackwards(text: string, to: number): number {
  let i = to;
  while (i > 0 && isBlank(text[i - 1])) {
    i--;
  }

  return i;
}
