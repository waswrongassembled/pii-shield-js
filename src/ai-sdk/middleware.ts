import type { LanguageModelMiddleware } from 'ai';

import { PiiShieldError } from '../errors.js';
import { PlaceholderStreamRestorer } from '../internal/placeholder-stream.js';
import type { PlaceholderMapping, RedactionResult, Redactor, VaultRedactor } from '../redaction.js';

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];
type Prompt = CallOptions['prompt'];
type Message = Prompt[number];
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapGenerate']>>>;
type Content = GenerateResult['content'][number];
type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware['wrapStream']>>>;
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;
type ToolResultOutput = Extract<
  Extract<Message, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>['output'];

/**
 * A message part that cannot be redacted (a file: image, audio, PDF, …) is in the prompt. It would reach
 * the provider with personal data, so the call is stopped before anything is sent (PHP's
 * UnsupportedContentException). Extract the text locally (e.g. OCR) and send text only.
 */
export class UnsupportedContentError extends PiiShieldError {
  declare readonly code: 'UNSUPPORTED_CONTENT';

  constructor(message: string) {
    super(message, 'UNSUPPORTED_CONTENT');
  }
}

/** Reported once per model call after the prompt was redacted. Holds no personal data. */
export interface RedactEvent {
  /** The placeholders the prompt was sent with, in order of assignment. */
  readonly placeholders: readonly string[];
  /** With `vault: true`: the id the mapping is stored under (`restoreFromVault()`, `forget()`). */
  readonly vaultId?: string;
}

/** Reported once per model call after its answer was restored (for a stream: when it ends). */
export interface RestoreEvent {
  /** Placeholders in the answer that are not in the mapping (the model invented them); they were left as they are. */
  readonly unknownPlaceholders: readonly string[];
}

export interface PiiShieldMiddlewareOptions {
  /**
   * Also store each call's mapping in the shield's vault (`redactToVault()`), e.g. to restore a stored
   * answer in a later request. The id is reported to `onRedact`. The shield needs a vault.
   */
  vault?: boolean;
  /** Called with the placeholders (and vault id) of each call; never with the original values. */
  onRedact?: (event: RedactEvent) => void;
  /** Called with the placeholders the model invented (PHP: result metadata `pii_shield.unknown_placeholders`). */
  onRestore?: (event: RestoreEvent) => void;
  /**
   * Send file, reasoning-file and custom parts of assistant messages unchanged. They cannot be redacted, and
   * the caller controls the history, so by default they are rejected (fail closed). Enable this only if such
   * parts come from the model itself and never carry personal data the provider has not seen.
   */
  allowOpaqueAssistantParts?: boolean;
}

/**
 * Joins all texts of a prompt for one consistent redaction: PHP's separator, contains no character any
 * detector matches. PHP throws when a text contains it (clarifile/pii-shield, PiiShieldProcessor); here it
 * gets longer until splitting the joined text gives the texts back (docs/DEVIATIONS.md).
 */
function joinTexts(texts: readonly string[]): { joined: string; separator: string } {
  for (let marks = 3; ; marks++) {
    const separator = `\n${'\u{2063}'.repeat(marks)}\n`;
    const joined = texts.join(separator);
    if (joined.split(separator).length === texts.length) {
      return { joined, separator };
    }
  }
}

/**
 * AI SDK language model middleware: the provider only ever sees placeholders, the caller gets the answer
 * with the original values (PHP's PiiShieldProcessor).
 *
 * ```ts
 * const model = wrapLanguageModel({ model: openai('gpt-5'), middleware: piiShieldMiddleware(new PiiShield()) });
 * ```
 *
 * - Prompt: all text of system, user, assistant and tool messages (text, reasoning, tool call inputs, tool
 *   results, approval reasons; string values of JSON, not keys) is redacted in one go, so the same value
 *   gets the same placeholder in every message. Every model call (every step of a tool loop) redacts the
 *   whole prompt again. Files in user and tool messages are rejected with `UnsupportedContentError` before
 *   anything is sent; files and custom parts of assistant messages pass unchanged.
 * - Answer: text, reasoning, tool call inputs (JSON string values) and provider-executed tool results are
 *   restored, in `generate` and in streams (a placeholder split across chunks is held back until complete).
 *   In JSON mode (structured output) values are inserted JSON-escaped, so the JSON stays valid.
 *   `providerMetadata`, raw chunks and request/response bodies are passed unchanged.
 *
 * The mapping stays in this process: it is kept per call in a WeakMap, never in the call options.
 * Async detectors (ModelDetector) work: the prompt is redacted with `redactAsync()` and the call's abort signal.
 */
export function piiShieldMiddleware(
  shield: Redactor | VaultRedactor,
  options: PiiShieldMiddlewareOptions = {},
): LanguageModelMiddleware {
  const { vault = false, onRedact, onRestore, allowOpaqueAssistantParts = false } = options;
  if (vault && !('redactToVault' in shield)) {
    throw new TypeError('The vault option needs a shield with redactToVault() (a PiiShield with a vault).');
  }
  const redactions = new WeakMap<CallOptions, RedactionResult>();

  const restorerFor = (params: CallOptions): CallRestorer | undefined => {
    const redaction = redactions.get(params);

    return redaction === undefined ? undefined : new CallRestorer(shield, redaction.mapping, isJsonMode(params));
  };
  const report = (restorer: CallRestorer): void => {
    onRestore?.({ unknownPlaceholders: Object.freeze([...restorer.unknown]) });
  };

  return {
    specificationVersion: 'v4',

    transformParams: async ({ params }) => {
      const texts: string[] = [];
      mapPromptTexts(
        params.prompt,
        (text) => {
          texts.push(text);

          return text;
        },
        allowOpaqueAssistantParts,
      );
      if (texts.length === 0) {
        return params;
      }

      const { joined, separator } = joinTexts(texts);
      const detectOptions = params.abortSignal === undefined ? {} : { signal: params.abortSignal };
      const redaction =
        vault && 'redactToVault' in shield
          ? await shield.redactToVault(joined, detectOptions)
          : await shield.redactAsync(joined, detectOptions);
      const redactedTexts = redaction.redactedText.split(separator);
      if (redactedTexts.length !== texts.length) {
        throw new Error('Redaction changed the message structure.');
      }

      let next = 0;
      const prompt = mapPromptTexts(params.prompt, () => redactedTexts[next++] ?? '', allowOpaqueAssistantParts);
      const redacted: CallOptions = { ...params, prompt };
      redactions.set(redacted, redaction);
      onRedact?.({
        placeholders: Object.freeze(Object.keys(redaction.mapping)),
        ...('vaultId' in redaction && typeof redaction.vaultId === 'string' ? { vaultId: redaction.vaultId } : {}),
      });

      return redacted;
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const restorer = restorerFor(params);
      if (restorer === undefined) {
        return result;
      }

      const restored: GenerateResult = {
        ...result,
        content: result.content.map((part) => restorer.content(part)),
      };
      if (result.structuredOutputText !== undefined) {
        restored.structuredOutputText = restorer.text(result.structuredOutputText);
      }
      report(restorer);

      return restored;
    },

    wrapStream: async ({ doStream, params }) => {
      const result = await doStream();
      const restorer = restorerFor(params);
      if (restorer === undefined) {
        return result;
      }

      const transform = restorer.streamTransform(() => {
        report(restorer);
      });

      return { ...result, stream: result.stream.pipeThrough(transform) };
    },
  };
}

/** Restores one model call's answer; collects the unknown placeholders. */
class CallRestorer {
  readonly unknown = new Set<string>();
  readonly #shield: Redactor;
  readonly #mapping: PlaceholderMapping;
  readonly #jsonEscaped: PlaceholderMapping;
  readonly #jsonMode: boolean;

  constructor(shield: Redactor, mapping: PlaceholderMapping, jsonMode: boolean) {
    this.#shield = shield;
    this.#mapping = mapping;
    this.#jsonEscaped = Object.fromEntries(
      Object.entries(mapping).map(([k, v]) => [k, JSON.stringify(v).slice(1, -1)]),
    );
    this.#jsonMode = jsonMode;
  }

  /** Plain text. */
  plain = (text: string): string => this.#restore(text, this.#mapping);

  /** Text inside JSON source: values are inserted JSON-escaped. */
  jsonSource = (text: string): string => this.#restore(text, this.#jsonEscaped);

  /** Answer text: JSON source in JSON mode (structured output), else plain. */
  text(text: string): string {
    return this.#jsonMode ? this.jsonSource(text) : this.plain(text);
  }

  /** A JSON document (a tool call input): string values are restored, keys and formatting of unchanged input kept. */
  json(source: string): string {
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      return this.jsonSource(source);
    }
    const restored = mapStrings(value, this.plain);

    return restored === value ? source : JSON.stringify(restored);
  }

  content(part: Content): Content {
    switch (part.type) {
      case 'text':
        return { ...part, text: this.text(part.text) };
      case 'reasoning':
        return { ...part, text: this.plain(part.text) };
      case 'tool-call':
        return { ...part, input: this.json(part.input) };
      case 'tool-result':
        return { ...part, result: mapStrings(part.result, this.plain) };
      default:
        return part;
    }
  }

  streamTransform(onEnd: () => void): TransformStream<StreamPart, StreamPart> {
    const open = new Map<string, PlaceholderStreamRestorer>();
    const restorerOf = (key: string, restore: (text: string) => string): PlaceholderStreamRestorer => {
      let restorer = open.get(key);
      if (restorer === undefined) {
        restorer = new PlaceholderStreamRestorer(restore);
        open.set(key, restorer);
      }

      return restorer;
    };
    const textRestore = (text: string): string => this.text(text);
    const inputRestore = new Map<string, (text: string) => string>();
    const flushed = (key: string): string => {
      const rest = open.get(key)?.flush() ?? '';
      open.delete(key);

      return rest;
    };
    const emitDelta = (
      controller: TransformStreamDefaultController<StreamPart>,
      part: Extract<StreamPart, { type: 'text-delta' | 'reasoning-delta' | 'tool-input-delta' }>,
      delta: string,
    ): void => {
      if (delta !== '' || part.providerMetadata !== undefined) {
        controller.enqueue({ ...part, delta });
      }
    };

    return new TransformStream<StreamPart, StreamPart>({
      transform: (part, controller) => {
        switch (part.type) {
          case 'text-delta':
            emitDelta(controller, part, restorerOf(`text:${part.id}`, textRestore).push(part.delta));
            return;
          case 'reasoning-delta':
            emitDelta(controller, part, restorerOf(`reasoning:${part.id}`, this.plain).push(part.delta));
            return;
          case 'tool-input-start':
            inputRestore.set(part.id, part.inputEncoding === 'text' ? this.plain : this.jsonSource);
            controller.enqueue(part);
            return;
          case 'tool-input-delta':
            emitDelta(
              controller,
              part,
              restorerOf(`tool-input:${part.id}`, inputRestore.get(part.id) ?? this.jsonSource).push(part.delta),
            );
            return;
          case 'text-end':
          case 'reasoning-end':
          case 'tool-input-end': {
            const kind = part.type.slice(0, -'-end'.length);
            const rest = flushed(`${kind}:${part.id}`);
            if (rest !== '') {
              controller.enqueue({ type: `${kind}-delta` as 'text-delta', id: part.id, delta: rest });
            }
            if (part.type === 'tool-input-end') {
              inputRestore.delete(part.id);
            }
            controller.enqueue(part);
            return;
          }
          case 'tool-call':
          case 'tool-result':
            controller.enqueue(this.content(part) as StreamPart);
            return;
          case 'finish':
            this.#flushAll(open, controller);
            controller.enqueue(part);
            return;
          default:
            controller.enqueue(part);
        }
      },
      flush: (controller) => {
        this.#flushAll(open, controller);
        onEnd();
      },
    });
  }

  /** Emits what is still held (a stream without -end parts) as deltas of its block. */
  #flushAll(
    open: Map<string, PlaceholderStreamRestorer>,
    controller: TransformStreamDefaultController<StreamPart>,
  ): void {
    for (const [key, restorer] of open) {
      const rest = restorer.flush();
      const separator = key.indexOf(':');
      if (rest !== '') {
        const type = `${key.slice(0, separator)}-delta` as 'text-delta';
        controller.enqueue({ type, id: key.slice(separator + 1), delta: rest });
      }
    }
    open.clear();
  }

  #restore(text: string, mapping: PlaceholderMapping): string {
    const restored = this.#shield.restore(text, mapping);
    for (const placeholder of restored.unknownPlaceholders) {
      this.unknown.add(placeholder);
    }

    return restored.text;
  }
}

function isJsonMode(params: CallOptions): boolean {
  return params.responseFormat?.type === 'json';
}

/**
 * Returns a copy of the prompt with every redactable text replaced by `replace(text)`, called in prompt order.
 *
 * @throws UnsupportedContentError for files in user and tool messages, and for file, reasoning-file and
 *   custom parts of assistant messages unless `allowOpaque` is set
 */
function mapPromptTexts(prompt: Prompt, replace: (text: string) => string, allowOpaque: boolean): Prompt {
  return prompt.map((message): Message => {
    switch (message.role) {
      case 'system':
        return { ...message, content: replace(message.content) };
      case 'user':
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === 'file') {
              throw unsupported('file');
            }

            return { ...part, text: replace(part.text) };
          }),
        };
      case 'assistant':
        return {
          ...message,
          content: message.content.map((part) => {
            switch (part.type) {
              case 'text':
              case 'reasoning':
                return { ...part, text: replace(part.text) };
              case 'tool-call':
                return { ...part, input: mapStrings(part.input, replace) };
              case 'tool-result':
                return { ...part, output: mapToolOutput(part.output, replace) };
              case 'file':
              case 'reasoning-file':
              case 'custom':
                if (allowOpaque) {
                  return part;
                }
                throw unsupported(part.type);
              default: {
                // Fail closed on part types added by later AI SDK versions.
                const unknownPart: { type: string } = part;
                throw unsupported(unknownPart.type);
              }
            }
          }),
        };
      case 'tool':
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === 'tool-result') {
              return { ...part, output: mapToolOutput(part.output, replace) };
            }

            return part.reason === undefined ? part : { ...part, reason: replace(part.reason) };
          }),
        };
    }
  });
}

function mapToolOutput(output: ToolResultOutput, replace: (text: string) => string): ToolResultOutput {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { ...output, value: replace(output.value) };
    case 'json':
    case 'error-json':
      return { ...output, value: mapStrings(output.value, replace) };
    case 'execution-denied':
      return output.reason === undefined ? output : { ...output, reason: replace(output.reason) };
    case 'content':
      return {
        ...output,
        value: output.value.map((item) => {
          if (item.type === 'file') {
            throw unsupported('file');
          }

          return item.type === 'text' ? { ...item, text: replace(item.text) } : item;
        }),
      };
  }
}

/**
 * Applies `replace` to every string in arrays and plain objects (JSON values), depth-first in key order,
 * each key before its value: keys can carry personal data too (e.g. `{"Maria Musterfrau": 3}`). Returns the
 * same reference when nothing changed (PHP's StructuredRestorer, which keeps keys); other values (numbers,
 * dates, class instances) are left as they are.
 *
 * @throws UnsupportedContentError if two keys of one object map to the same key
 */
function mapStrings<T>(value: T, replace: (text: string) => string): T {
  if (typeof value === 'string') {
    return replace(value) as T;
  }
  if (Array.isArray(value)) {
    const mapped: unknown[] = value.map((item: unknown) => mapStrings(item, replace));

    return (mapped.some((item, i) => item !== value[i]) ? mapped : value) as T;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();
    for (const [key, item] of Object.entries(value)) {
      const mappedKey = replace(key);
      if (keys.has(mappedKey)) {
        throw new UnsupportedContentError('Two keys of a JSON object map to the same key; it cannot be redacted.');
      }
      keys.add(mappedKey);
      const mapped = mapStrings(item, replace);
      changed ||= mappedKey !== key || mapped !== item;
      entries.push([mappedKey, mapped]);
    }

    return (changed ? Object.fromEntries(entries) : value) as T;
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

function unsupported(type: string): UnsupportedContentError {
  return new UnsupportedContentError(
    `Content of type "${type}" cannot be redacted. Extract its text locally and send text only.`,
  );
}
