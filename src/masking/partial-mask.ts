import type { Entity } from '../entity.js';
import type { MaskingStrategy } from './strategy.js';

export interface PartialMaskOptions {
  /** Visible characters at the start; default 0. */
  keepStart?: number;
  /** Visible characters at the end; default 0. */
  keepEnd?: number;
  /** Replacement for each hidden character; default "*". */
  maskChar?: string;
}

/** PHP's ctype_space() on one character: ASCII whitespace only, so a no-break space is masked. */
const ASCII_SPACE = /^[\t\n\v\f\r ]$/;

/**
 * Keeps the first and last n characters, masks everything else except whitespace:
 * "AT61 1904 3002 3457 3201" → "AT61 **** **** **** 3201".
 *
 * Characters are code points, as PHP's mb_str_split() counts them. Values not longer than
 * keepStart + keepEnd are masked completely, otherwise nothing would be hidden.
 * Leaks length and format by design; meant for logs and previews, not for model providers.
 */
export class PartialMask implements MaskingStrategy {
  readonly #keepStart: number;
  readonly #keepEnd: number;
  readonly #maskChar: string;

  constructor(options: PartialMaskOptions = {}) {
    const { keepStart = 0, keepEnd = 0, maskChar = '*' } = options;
    for (const keep of [keepStart, keepEnd]) {
      if (!Number.isInteger(keep) || keep < 0) {
        throw new RangeError(
          keep < 0 ? 'Characters to keep must not be negative.' : 'Characters to keep must be an integer.',
        );
      }
    }
    this.#keepStart = keepStart;
    this.#keepEnd = keepEnd;
    this.#maskChar = maskChar;
  }

  mask(entity: Entity): string {
    const chars = [...entity.value];
    const visible = chars.filter((c) => !ASCII_SPACE.test(c)).length;
    const fullyMasked = visible <= this.#keepStart + this.#keepEnd;

    let result = '';
    let position = 0;
    for (const char of chars) {
      if (ASCII_SPACE.test(char)) {
        result += char;
        continue;
      }
      const keep = !fullyMasked && (position < this.#keepStart || position >= visible - this.#keepEnd);
      result += keep ? char : this.#maskChar;
      position++;
    }

    return result;
  }
}
