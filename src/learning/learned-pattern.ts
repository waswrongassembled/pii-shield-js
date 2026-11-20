/**
 * Compiles and runs learned patterns with PCRE semantics, without JavaScript's regex engine.
 *
 * Patterns are stored in PHP/PCRE syntax (`~(?:…)~u`, i.e. UTF + UCP), so they must mean the same here.
 * Rather than translating them to a JavaScript RegExp, which has no backtracking limit and differs in
 * details (empty matches, `[]a]`, `\s`, `.`), they run on a small backtracking matcher for the
 * PatternGrammar subset: single-character sets with greedy quantifiers, alternation and plain groups.
 *
 * Like PCRE with `pcre.backtrack_limit`, every match attempt has a budget. The engine counts each
 * choice point it creates and each time it backtracks into one, per start position; PHP's limit of
 * 100000 was calibrated against PCRE2's JIT (e.g. `.{0,45}` three times passes, `.{0,46}` three times
 * does not). Exceeding it makes a search fail, the same way preg_match() returns false. Greedy runs
 * reuse a per-instruction cache and runs that cannot give characters back create no choice point
 * (PCRE's auto-possessification). matchAll() also has an overall budget linear in the text length.
 *
 * @internal
 */
import {
  complement,
  digit,
  dot,
  intersects,
  letterOrNumber,
  membership,
  type Ranges,
  space,
  union,
  word,
} from './char-set.js';

/** pcre.backtrack_limit used by PHP's CustomEntityType and CustomEntityDetector. */
export const BACKTRACK_LIMIT = 100_000;
/** Overall budget of one matchAll(): PHP has none, but JavaScript must not run quadratic on adversarial text. */
const TOTAL_BASE = 1_000_000;
const TOTAL_PER_CHARACTER = 50;

interface SetItem {
  readonly kind: 'set';
  readonly set: Ranges;
  min: number;
  max: number;
  quantified: boolean;
}

interface GroupItem {
  readonly kind: 'group';
  readonly alternatives: Item[][];
}

type Item = SetItem | GroupItem;

/** Thrown inside the parser: "invalid" = PCRE would not compile it; "unsupported" = outside the grammar subset. */
class ParseFailure extends Error {
  constructor(readonly reason: 'invalid' | 'unsupported') {
    super(reason);
  }
}

const SHORTHANDS: Record<string, () => Ranges> = {
  d: digit,
  D: () => complement(digit()),
  w: word,
  W: () => complement(word()),
  s: space,
  S: () => complement(space()),
};

const isAsciiAlnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);

function single(c: string): Ranges {
  const cp = c.codePointAt(0) ?? 0;

  return [cp, cp];
}

class Parser {
  readonly #chars: readonly string[];
  #i = 0;

  constructor(pattern: string) {
    this.#chars = Array.from(pattern);
  }

  parse(): Item[][] {
    const alternatives = this.#alternation(0);
    if (this.#i < this.#chars.length) {
      throw new ParseFailure('invalid'); // unmatched ")"
    }

    return alternatives;
  }

  #alternation(depth: number): Item[][] {
    const alternatives: Item[][] = [[]];
    for (;;) {
      const c = this.#chars[this.#i];
      const sequence = alternatives[alternatives.length - 1] ?? [];
      if (c === undefined) {
        if (depth > 0) {
          throw new ParseFailure('invalid'); // missing ")"
        }

        return alternatives;
      }
      this.#i++;
      switch (c) {
        case '|':
          alternatives.push([]);
          break;
        case ')':
          if (depth === 0) {
            throw new ParseFailure('invalid');
          }

          return alternatives;
        case '(':
          if (this.#chars[this.#i] === '?') {
            if (this.#chars[this.#i + 1] !== ':') {
              throw new ParseFailure('unsupported');
            }
            this.#i += 2;
          }
          sequence.push({ kind: 'group', alternatives: this.#alternation(depth + 1) });
          break;
        case '*':
        case '+':
        case '?':
          this.#quantify(sequence, c === '+' ? 1 : 0, c === '?' ? 1 : Infinity);
          break;
        case '{':
          this.#brace(sequence);
          break;
        case '[':
          sequence.push(setItem(this.#class()));
          break;
        case '\\':
          sequence.push(setItem(this.#escape()));
          break;
        case '.':
          sequence.push(setItem(dot()));
          break;
        case '^':
        case '$':
          throw new ParseFailure('unsupported');
        case '~':
          throw new ParseFailure('invalid'); // ends PHP's "~…~u" delimiters
        default:
          sequence.push(setItem(single(c)));
      }
    }
  }

  #brace(sequence: Item[]): void {
    const rest = this.#chars.slice(this.#i, this.#i + 16).join('');
    const m = /^([0-9]+)(?:,([0-9]*))?\}/.exec(rest);
    if (m === null) {
      if (/^\s*,?\s*[0-9]/.test(rest)) {
        throw new ParseFailure('unsupported'); // {,n} or spaces: newer PCRE2 syntax
      }
      sequence.push(setItem(single('{')));

      return;
    }
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[2] === '' ? Infinity : Number(m[2]);
    if (min > 65535 || max < min || (max !== Infinity && max > 65535)) {
      throw new ParseFailure('invalid');
    }
    this.#i += m[0].length;
    this.#quantify(sequence, min, max);
  }

  #quantify(sequence: Item[], min: number, max: number): void {
    const last = sequence[sequence.length - 1];
    if (last === undefined) {
      throw new ParseFailure('invalid'); // nothing to repeat
    }
    if (last.kind === 'group' || last.quantified) {
      throw new ParseFailure('unsupported');
    }
    const next = this.#chars[this.#i];
    if (next === '?' || next === '+') {
      throw new ParseFailure('unsupported');
    }
    last.min = min;
    last.max = max;
    last.quantified = true;
  }

  /** After a backslash. */
  #escape(): Ranges {
    const next = this.#chars[this.#i++];
    if (next === undefined) {
      throw new ParseFailure('invalid');
    }
    const shorthand = SHORTHANDS[next];
    if (shorthand !== undefined) {
      return shorthand();
    }
    if (isAsciiAlnum(next)) {
      throw new ParseFailure('unsupported'); // \b, \n, \x41, \p{L}, backreferences, ...
    }

    return single(next);
  }

  /** After "[". PCRE rules: "]" first is literal, "-" at either end is literal, no shorthand in a range. */
  #class(): Ranges {
    let negated = false;
    if (this.#chars[this.#i] === '^') {
      negated = true;
      this.#i++;
    }
    const parts: Ranges[] = [];
    for (let first = true; ; first = false) {
      const c = this.#chars[this.#i];
      if (c === undefined) {
        throw new ParseFailure('invalid');
      }
      if (c === ']' && !first) {
        this.#i++;
        break;
      }
      const atom = this.#classAtom();
      if (this.#chars[this.#i] === '-' && this.#chars[this.#i + 1] !== undefined && this.#chars[this.#i + 1] !== ']') {
        if (atom.shorthand) {
          throw new ParseFailure('invalid');
        }
        this.#i++;
        const end = this.#classAtom();
        if (end.shorthand) {
          throw new ParseFailure('invalid');
        }
        const lo = atom.set[0] ?? 0;
        const hi = end.set[0] ?? 0;
        if (lo > hi) {
          throw new ParseFailure('invalid');
        }
        parts.push([lo, hi]);
      } else {
        parts.push(atom.set);
      }
    }
    const set = union(...parts);

    return negated ? complement(set) : set;
  }

  #classAtom(): { set: Ranges; shorthand: boolean } {
    const c = this.#chars[this.#i++] ?? '';
    if (c === '[') {
      throw new ParseFailure('unsupported'); // POSIX classes and nesting are outside the grammar
    }
    if (c === '~') {
      throw new ParseFailure('invalid');
    }
    if (c === '\\') {
      const next = this.#chars[this.#i];
      const set = this.#escape();

      return { set, shorthand: next !== undefined && next in SHORTHANDS };
    }

    return { set: single(c), shorthand: false };
  }
}

function setItem(set: Ranges): SetItem {
  return { kind: 'set', set, min: 1, max: 1, quantified: false };
}

/**
 * Best guess whether PCRE compiles a pattern that lies outside the grammar subset. Only decides which of
 * two rejection messages the caller shows: such patterns are rejected by the grammar anyway.
 */
function pcreLikelyCompiles(pattern: string): boolean {
  const chars = Array.from(pattern);
  let depth = 0;
  let canRepeat = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '~') {
      return false;
    }
    if (c === '\\') {
      if (chars[i + 1] === undefined) {
        return false;
      }
      i++;
      canRepeat = true;
    } else if (c === '[') {
      let j = i + 1;
      if (chars[j] === '^') {
        j++;
      }
      if (chars[j] === ']') {
        j++;
      }
      for (; j < chars.length && chars[j] !== ']'; j++) {
        if (chars[j] === '\\') {
          j++;
        } else if (chars[j] === '~') {
          return false;
        } else if (chars[j] === '[' && chars[j + 1] === ':') {
          const close = chars.indexOf(']', j);
          j = close === -1 ? chars.length : close;
        }
      }
      if (j >= chars.length) {
        return false;
      }
      i = j;
      canRepeat = true;
    } else if (c === '(') {
      depth++;
      canRepeat = false;
      if (chars[i + 1] === '?') {
        i++;
      }
    } else if (c === ')') {
      if (depth-- === 0) {
        return false;
      }
      canRepeat = true;
    } else if (c === '|') {
      canRepeat = false;
    } else if (c === '*' || c === '+' || c === '?') {
      if (!canRepeat) {
        return false;
      }
      canRepeat = false;
      if (chars[i + 1] === '?' || chars[i + 1] === '+') {
        i++;
      }
    } else if (c === '{' && /^\{[0-9]+(?:,[0-9]*)?\}/.test(chars.slice(i, i + 16).join(''))) {
      if (!canRepeat) {
        return false;
      }
      canRepeat = false;
      i = chars.indexOf('}', i);
    } else {
      canRepeat = true;
    }
  }

  return depth === 0;
}

// ---------------------------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------------------------

interface SetInstruction {
  readonly op: 'set';
  readonly set: Ranges;
  readonly has: (cp: number) => boolean;
  readonly min: number;
  readonly max: number;
  readonly next: number;
  /** No shorter run can lead to a match (PCRE's auto-possessification): no choice point needed. */
  possessive: boolean;
}

interface SplitInstruction {
  readonly op: 'split';
  readonly alternatives: readonly number[];
}

type Instruction = SetInstruction | SplitInstruction | { readonly op: 'match' };

function compile(alternatives: Item[][]): Instruction[] {
  const program: Instruction[] = [{ op: 'match' }];
  const emit = (instruction: Instruction): number => program.push(instruction) - 1;

  const sequence = (items: readonly Item[], next: number): number => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item === undefined) {
        continue;
      }
      if (item.kind === 'set') {
        next = emit({
          op: 'set',
          set: item.set,
          has: membership(item.set),
          min: item.min,
          max: item.max,
          next,
          possessive: false,
        });
      } else {
        next = alternation(item.alternatives, next);
      }
    }

    return next;
  };
  const alternation = (alts: readonly Item[][], next: number): number => {
    if (alts.length === 1) {
      return sequence(alts[0] ?? [], next);
    }

    return emit({ op: 'split', alternatives: alts.map((alt) => sequence(alt, next)) });
  };

  const start = alternation(alternatives, 0);
  // The entry point goes last; move it to a known index.
  program.push({ op: 'split', alternatives: [start] });

  // FIRST set of each continuation, and whether it can reach the end without consuming.
  const firsts = new Map<number, { set: Ranges; end: boolean }>();
  const first = (pc: number): { set: Ranges; end: boolean } => {
    const known = firsts.get(pc);
    if (known !== undefined) {
      return known;
    }
    const instruction = program[pc];
    let result: { set: Ranges; end: boolean };
    if (instruction === undefined || instruction.op === 'match') {
      result = { set: [], end: true };
    } else if (instruction.op === 'set') {
      const rest = instruction.min > 0 ? { set: [], end: false } : first(instruction.next);
      result = { set: union(instruction.set, rest.set), end: rest.end };
    } else {
      const parts = instruction.alternatives.map(first);
      result = { set: union(...parts.map((p) => p.set)), end: parts.some((p) => p.end) };
    }
    firsts.set(pc, result);

    return result;
  };
  for (const instruction of program) {
    if (instruction.op === 'set' && instruction.max > instruction.min) {
      const follow = first(instruction.next);
      instruction.possessive = !follow.end && !intersects(instruction.set, follow.set);
    }
  }

  return program;
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

/** The search or match ran over its backtracking budget (PHP: preg_match() returns false). */
export class BacktrackLimitExceeded extends Error {}

/** A text prepared for matching: code points plus their UTF-16 offsets. */
export class Subject {
  readonly codePoints: Int32Array;
  readonly offsets: Int32Array;
  /** Run caches of the programs that searched this text. */
  readonly runs = new WeakMap<object, { from: Int32Array; end: Int32Array }>();

  constructor(readonly text: string) {
    const cps: number[] = [];
    const offsets: number[] = [];
    for (let i = 0; i < text.length;) {
      const cp = text.codePointAt(i) ?? 0;
      cps.push(cp);
      offsets.push(i);
      i += cp > 0xffff ? 2 : 1;
    }
    offsets.push(text.length);
    this.codePoints = Int32Array.from(cps);
    this.offsets = Int32Array.from(offsets);
  }
}

let isLetterOrNumber: ((cp: number) => boolean) | undefined;

interface ExecOptions {
  /** `~^(?:…)$~u` (PCRE: $ also before a final "\n") instead of the whole-word search. */
  readonly whole: boolean;
  readonly anchored: boolean;
  /** PCRE2_NOTEMPTY_ATSTART: an empty match at the start position does not count. */
  readonly notEmptyAtStart: boolean;
  /** Budget per start position (PCRE2's JIT counts per start, too). */
  readonly limit: number;
  /** Budget for a whole matchAll(), so the search stays linear in the text. */
  readonly total?: { steps: number; readonly max: number };
}

/** A compiled learned pattern. */
export class LearnedPattern {
  readonly #program: Instruction[];
  readonly #entry: number;

  private constructor(program: Instruction[]) {
    this.#program = program;
    this.#entry = program.length - 1;
  }

  /**
   * Compiles a pattern, or says why not: "invalid" (PCRE would not compile it either) or "unsupported"
   * (outside the grammar subset; `compiles` then guesses what PCRE says).
   */
  static compile(pattern: string): LearnedPattern | { error: 'invalid' | 'unsupported'; compiles: boolean } {
    try {
      return new LearnedPattern(compile(new Parser(pattern).parse()));
    } catch (e) {
      if (e instanceof ParseFailure) {
        return { error: e.reason, compiles: e.reason === 'unsupported' && pcreLikelyCompiles(pattern) };
      }
      throw e;
    }
  }

  /** `preg_match('~^(?:…)$~u', $text)`; false also when the budget runs out. */
  matchesWhole(text: string, limit = Infinity): boolean {
    try {
      return this.#exec(new Subject(text), 0, { whole: true, anchored: true, notEmptyAtStart: false, limit }) !== null;
    } catch (e) {
      if (e instanceof BacktrackLimitExceeded) {
        return false;
      }
      throw e;
    }
  }

  /**
   * `preg_match('~(?<![\p{L}\p{N}])(?:…)(?![\p{L}\p{N}])~u', $text)` within the budget: `limit` per start
   * position like PCRE, and optionally a `total` shared across calls (see runsInBoundedTime()).
   */
  searchesWithin(text: string, limit: number, total?: { steps: number; readonly max: number }): boolean {
    try {
      this.#exec(new Subject(text), 0, {
        whole: false,
        anchored: false,
        notEmptyAtStart: false,
        limit,
        ...(total === undefined ? {} : { total }),
      });

      return true;
    } catch (e) {
      if (e instanceof BacktrackLimitExceeded) {
        return false;
      }
      throw e;
    }
  }

  /**
   * All whole-word matches like preg_match_all(), with UTF-16 offsets; empty matches are dropped (as
   * RegexMatcher does). Throws BacktrackLimitExceeded when one search exceeds the budget.
   */
  matchAll(text: string, limit = BACKTRACK_LIMIT): { value: string; offset: number }[] {
    const subject = new Subject(text);
    const n = subject.codePoints.length;
    const result: { value: string; offset: number }[] = [];
    let position = 0;
    let notEmpty = false;
    const total = { steps: 0, max: TOTAL_BASE + TOTAL_PER_CHARACTER * n };
    while (position <= n) {
      const match = this.#exec(subject, position, {
        whole: false,
        anchored: notEmpty,
        notEmptyAtStart: notEmpty,
        limit,
        total,
      });
      if (match === null) {
        if (!notEmpty || position >= n) {
          break;
        }
        // After an empty match PCRE retries non-empty at the same place, then moves on by one character.
        notEmpty = false;
        position++;
        continue;
      }
      const [start, end] = match;
      if (end > start) {
        const from = subject.offsets[start] ?? 0;
        result.push({ value: text.slice(from, subject.offsets[end]), offset: from });
      }
      position = end;
      notEmpty = end === start;
    }

    return result;
  }

  #exec(subject: Subject, from: number, options: ExecOptions): [number, number] | null {
    isLetterOrNumber ??= membership(letterOrNumber());
    const isLN = isLetterOrNumber;
    const program = this.#program;
    const cps = subject.codePoints;
    const n = cps.length;
    // Per set instruction: a known run [runFrom, runEnd) of members followed by a non-member (or the end).
    // Kept on the subject, so the searches of one matchAll() share it.
    let runs = subject.runs.get(program);
    if (runs === undefined) {
      runs = { from: new Int32Array(program.length).fill(-1), end: new Int32Array(program.length) };
      subject.runs.set(program, runs);
    }
    const { from: runFrom, end: runEnd } = runs;
    const stackPc: number[] = [];
    const stackPos: number[] = [];
    const stackK: number[] = [];
    let steps: number;
    const total = options.total ?? { steps: 0, max: Infinity };

    const runLength = (pc: number, instruction: SetInstruction, pos: number): number => {
      const cachedFrom = runFrom[pc] ?? -1;
      const cachedEnd = runEnd[pc] ?? 0;
      let end: number;
      if (cachedFrom !== -1 && pos >= cachedFrom && pos <= cachedEnd) {
        end = cachedEnd;
      } else {
        end = pos;
        while (end < n && instruction.has(cps[end] ?? 0)) {
          end++;
          if (end === cachedFrom && cachedFrom !== -1) {
            end = cachedEnd;
            break;
          }
        }
        runFrom[pc] = pos;
        runEnd[pc] = end;
      }

      return Math.min(end - pos, instruction.max);
    };

    for (let start = from; start <= n; start++) {
      if (!options.whole && start > 0 && isLN(cps[start - 1] ?? 0)) {
        if (options.anchored) {
          return null;
        }
        continue;
      }
      let pc = this.#entry;
      let pos = start;
      steps = 0;
      stackPc.length = 0;
      stackPos.length = 0;
      stackK.length = 0;
      for (;;) {
        const instruction = program[pc];
        let failed = false;
        if (instruction === undefined || instruction.op === 'match') {
          const atEnd = options.whole
            ? pos === n || (pos === n - 1 && cps[pos] === 0x0a)
            : pos === n || !isLN(cps[pos] ?? 0);
          if (atEnd && !(options.notEmptyAtStart && pos === start)) {
            return [start, pos];
          }
          failed = true;
        } else if (instruction.op === 'set') {
          const k = runLength(pc, instruction, pos);
          if (k < instruction.min) {
            failed = true;
          } else {
            if (k > instruction.min && !instruction.possessive) {
              stackPc.push(pc);
              stackPos.push(pos);
              stackK.push(k);
              if (++steps > options.limit || ++total.steps > total.max) {
                throw new BacktrackLimitExceeded();
              }
            }
            pos += k;
            pc = instruction.next;
          }
        } else {
          if (instruction.alternatives.length > 1) {
            stackPc.push(pc);
            stackPos.push(pos);
            stackK.push(0);
            if (++steps > options.limit || ++total.steps > total.max) {
              throw new BacktrackLimitExceeded();
            }
          }
          pc = instruction.alternatives[0] ?? 0;
        }
        if (!failed) {
          continue;
        }
        // Backtrack into the most recent choice point.
        const top = stackPc.length - 1;
        if (top < 0) {
          break;
        }
        if (++steps > options.limit || ++total.steps > total.max) {
          throw new BacktrackLimitExceeded();
        }
        const framePc = stackPc[top] ?? 0;
        const framePos = stackPos[top] ?? 0;
        const frameK = stackK[top] ?? 0;
        const frame = program[framePc];
        if (frame?.op === 'set') {
          const k = frameK - 1;
          if (k > frame.min) {
            stackK[top] = k;
          } else {
            stackPc.pop();
            stackPos.pop();
            stackK.pop();
          }
          pos = framePos + k;
          pc = frame.next;
        } else if (frame?.op === 'split') {
          const index = frameK + 1;
          if (index < frame.alternatives.length - 1) {
            stackK[top] = index;
          } else {
            stackPc.pop();
            stackPos.pop();
            stackK.pop();
          }
          pos = framePos;
          pc = frame.alternatives[index] ?? 0;
        }
      }
      if (options.anchored) {
        return null;
      }
    }

    return null;
  }
}
