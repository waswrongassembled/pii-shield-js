import {
  isPlaceholderPrefix,
  PLACEHOLDER_PREFIX_DONE,
  placeholderLengthAt,
  placeholderPrefixState,
  stepPlaceholderPrefix,
} from '../placeholder.js';

/** Default of `maxPending`: far longer than any placeholder a model writes. */
export const DEFAULT_MAX_PENDING = 1024;

/**
 * Restores placeholders in a text that arrives in chunks (a streamed model answer).
 *
 * `push()` returns the restored text that is safe to emit; a possible placeholder at the end of the
 * chunks so far (`⟦PERS`, `[[iban`, a single trailing `[`, `⟦TAX\`) is held back until it is complete
 * or can no longer become one. The concatenated output equals `restore(whole text)`, however the text is
 * split, so a partial placeholder is never emitted.
 *
 * A held candidate longer than `maxPending` UTF-16 units is given up and emitted as it is, so a stray
 * `[[` followed by endless whitespace cannot hold the stream forever. Each chunk costs time linear in its
 * length (plus the held text when a candidate ends).
 *
 * @internal
 */
export class PlaceholderStreamRestorer {
  /** Held text: empty, or a possible placeholder from its first character on. */
  #pending = '';
  /** Automaton state of `#pending` (see stepPlaceholderPrefix()). */
  #state = 0;
  /** A high surrogate at the end of the last chunk, waiting for its pair. */
  #highSurrogate = '';
  readonly #restore: (text: string) => string;
  readonly #maxPending: number;

  constructor(restore: (text: string) => string, maxPending = DEFAULT_MAX_PENDING) {
    this.#restore = restore;
    this.#maxPending = maxPending;
  }

  /** Adds a chunk; returns the restored text that can be emitted now (may be empty). */
  push(chunk: string): string {
    let input = this.#highSurrogate + chunk;
    this.#highSurrogate = '';
    const last = input.charCodeAt(input.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.#highSurrogate = input.slice(-1);
      input = input.slice(0, -1);
    }

    if (this.#pending !== '' && this.#pending.length + input.length <= this.#maxPending) {
      const state = this.#advance(input);
      if (state !== 0 && (state & PLACEHOLDER_PREFIX_DONE) === 0) {
        this.#pending += input;
        this.#state = state;

        return '';
      }
    }

    const text = this.#pending + input;
    let cut = heldFrom(text, 0);
    while (text.length - cut > this.#maxPending) {
      cut = heldFrom(text, cut + 1);
    }
    this.#pending = text.slice(cut);
    this.#state = this.#pending === '' ? 0 : placeholderPrefixState(this.#pending, 0);

    return cut === 0 ? '' : this.#restore(text.slice(0, cut));
  }

  /** Ends the text: returns whatever is held, restored (an unfinished placeholder stays as it is). */
  flush(): string {
    const text = this.#pending + this.#highSurrogate;
    this.#pending = '';
    this.#state = 0;
    this.#highSurrogate = '';

    return text === '' ? '' : this.#restore(text);
  }

  /** State of the held candidate after `input`; stops early at 0 or a complete placeholder. */
  #advance(input: string): number {
    let state = this.#state;
    for (let i = 0; i < input.length;) {
      const c = String.fromCodePoint(input.codePointAt(i) ?? 0);
      state = stepPlaceholderPrefix(state, c);
      if (state === 0 || (state & PLACEHOLDER_PREFIX_DONE) !== 0) {
        return state;
      }
      i += c.length;
    }

    return state;
  }
}

/**
 * Start of the first possible, unfinished placeholder at or after `from`, or `text.length`. Complete
 * placeholders are skipped like the restore regex skips them, so the text before the result restores
 * exactly as it does inside the whole text.
 */
function heldFrom(text: string, from: number): number {
  const nextOpener = openerFinder(text);
  let i = from;
  for (;;) {
    const j = nextOpener(i);
    if (j === -1) {
      return text.length;
    }
    const length = placeholderLengthAt(text, j);
    if (length !== -1) {
      i = j + length;
    } else if (isPlaceholderPrefix(text, j)) {
      return j;
    } else {
      i = j + 1;
    }
  }
}

/** Finds the next `⟦` or `[` at or after a growing position; remembers each search, so a scan is linear. */
function openerFinder(text: string): (from: number) => number {
  let bracket = -2;
  let square = -2;

  return (from) => {
    if (bracket !== -1 && bracket < from) bracket = text.indexOf('⟦', from);
    if (square !== -1 && square < from) square = text.indexOf('[', from);
    if (bracket === -1) {
      return square;
    }

    return square === -1 ? bracket : Math.min(bracket, square);
  };
}
