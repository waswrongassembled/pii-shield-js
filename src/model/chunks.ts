import { DetectionError } from '../errors.js';
import { codePointLength } from '../internal/pcre.js';

/** More chunks fail closed instead of fanning out (about 200,000 characters at the default size). */
export const MAX_CHUNKS = 50;
/** Each chunk repeats the last fifth of the previous one. */
const OVERLAP_DIVISOR = 5;
const SEPARATORS: readonly (readonly string[])[] = [['\n', '\n'], ['\n'], [' ']];
const WORD_BREAKS = new Set([' ', '\n', '\t']);

/**
 * Splits a text into chunks of at most `size` code points: a window over the original text, cut at the
 * last paragraph break in its second half, else the last line break, else the last space. Each chunk
 * starts an overlap of the window before the previous end (at a word start), wherever the cut was, so a
 * value shorter than the overlap is always sent whole in at least one chunk.
 *
 * @throws DetectionError before anything is sent, if the text needs more than MAX_CHUNKS chunks
 *
 * @internal
 */
export function chunks(text: string, size: number): string[] {
  // Each chunk advances by at least a tenth of the size: decide before splitting a huge text.
  const length = codePointLength(text);
  if (length > MAX_CHUNKS * size) {
    throw tooLong(Math.floor(length / size) + 1, size);
  }
  if (length <= size) {
    return [text];
  }
  const chars = Array.from(text);

  const overlap = Math.floor(size / OVERLAP_DIVISOR);
  const result: string[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(length, start + size);
    if (end < length) {
      for (const separator of SEPARATORS) {
        const cut = lastIndexOf(chars, start, end, separator);
        if (cut !== -1 && cut >= Math.floor((end - start) / 2)) {
          end = start + cut + separator.length;
          break;
        }
      }
    }
    result.push(chars.slice(start, end).join(''));
    if (end >= length) {
      return result;
    }

    // Back to a word start, but only within one more overlap: text without spaces must still
    // advance by at least a tenth of the size per chunk (cut in the second half, minus 2 overlaps).
    let next = end - overlap;
    const limit = Math.max(start + 1, end - 2 * overlap);
    while (next > limit && !WORD_BREAKS.has(chars[next - 1] ?? '')) {
      next--;
    }
    if (next <= limit) {
      next = end - overlap;
    }
    start = Math.max(start + 1, next);
    if (result.length >= MAX_CHUNKS) {
      throw tooLong(result.length + 1, size);
    }
  }
}

/** Position of the last `separator` inside chars[start, end), relative to start (mb_strrpos()), or -1. */
function lastIndexOf(chars: readonly string[], start: number, end: number, separator: readonly string[]): number {
  for (let i = end - separator.length; i >= start; i--) {
    if (separator.every((c, j) => chars[i + j] === c)) {
      return i - start;
    }
  }

  return -1;
}

function tooLong(count: number, size: number): DetectionError {
  return new DetectionError(
    `The text is too long for model-based detection: at least ${String(count)} chunks of ${String(size)} characters, at most ${String(MAX_CHUNKS)}.`,
    'DETECTION_TEXT_TOO_LONG',
  );
}
