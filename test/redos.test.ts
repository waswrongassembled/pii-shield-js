import { describe, expect, it } from 'vitest';

import {
  CustomEntityDetector,
  defaultDetectors,
  defineCustomEntityType,
  EntityExtractor,
  PhoneDetector,
  PiiShieldError,
} from '../src/index.js';
import { DIGIT, WORD_CHARS } from '../src/internal/pcre.js';
import { LearnedPattern } from '../src/learning/learned-pattern.js';

/**
 * Detectors run on every text, so none may backtrack catastrophically. PHP is protected by
 * pcre.backtrack_limit (it throws); JavaScript has no limit and would hang.
 */
const n = 5000;
const adversarial: Record<string, string> = {
  'digit run before a letter': `0${'1'.repeat(n)}a`,
  'international digit run before a letter': `+${'4'.repeat(n)}x`,
  'spaced digit groups': `0${' 12'.repeat(n / 3)}a`,
  'slashed digit groups': `0${'/12'.repeat(n / 3)}a`,
  'IBAN-like groups': `AT61${' 1904'.repeat(n / 5)}X`,
  letters: `${'A'.repeat(n)}!`,
  'repeated first name': `Frau ${'Maria '.repeat(n / 6)}x`,
  'repeated street lines': `${'Lindenweg 12\n'.repeat(n / 13)}x`,
  'letter-digit-dash': `${'A1-'.repeat(n / 3)}!`,
  spaces: `${' '.repeat(n)}x`,
  'dotted digits': `${'1.'.repeat(n / 2)}x`,
  'dotted local part': `${'a.'.repeat(n / 2)}@`,
  'dotted domain': `a@${'b.'.repeat(n / 2)}!`,
  'repeated salutation lines': `${'Herrn\n'.repeat(n / 6)}x`,
  'plate after keyword': `Kennzeichen ${'AB-'.repeat(n / 3)}1`,
  'file number after keyword': `Zahl: ${'AB-1/'.repeat(n / 5)}!`,
};
const LIMIT_MS = 1000;

describe('no catastrophic backtracking', () => {
  for (const detector of defaultDetectors()) {
    it.each(Object.entries(adversarial))(`${detector.constructor.name}: %s`, (_, text) => {
      const start = performance.now();
      detector.detect(text);
      expect(performance.now() - start).toBeLessThan(LIMIT_MS);
    });
  }

  it('the extractor handles all inputs at once', () => {
    const start = performance.now();
    new EntityExtractor().extract(Object.values(adversarial).join('\n'));
    expect(performance.now() - start).toBeLessThan(LIMIT_MS * 2);
  });
});

describe('phone pattern without backtracking blow-up', () => {
  // PHP's original pattern; only safe on short inputs.
  const php = new RegExp(
    String.raw`(?<![${WORD_CHARS}+\/])(?:(?:\+|00)${DIGIT}{1,3}|0${DIGIT}{1,4})(?:[ \/\-]?${DIGIT}{2,}){1,5}(?![${WORD_CHARS}\/])`,
    'gu',
  );
  const alphabet = ['0', '0', '1', '2', '3', '+', '/', '-', ' ', 'a', '\n', '.'];
  // Deterministic pseudo-random strings (LCG), so failures are reproducible.
  let seed = 42;
  const random = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % max;
  };

  it('finds exactly what the PHP pattern finds on 20000 random short texts', () => {
    const detector = new PhoneDetector({ keepAuthorityContacts: false });
    for (let i = 0; i < 20000; i++) {
      const text = Array.from({ length: 1 + random(24) }, () => alphabet[random(alphabet.length)]).join('');
      const expected = [...text.matchAll(php)]
        .map((m) => ({ value: m[0], offset: m.index }))
        .filter((m) => m.value.replace(/[^0-9]/g, '').length >= 7);
      const actual = detector.detect(text).map((e) => ({ value: e.value, offset: e.offset }));
      expect(actual, JSON.stringify(text)).toEqual(expected);
    }
  });
});

describe('learned patterns', () => {
  // Accepted patterns that backtrack most, plus typical learned ones.
  const patterns: [string, string][] = [
    [String.raw`VN-\d{4}-\d{6}`, 'VN-2026-000417'],
    [String.raw`(?:[A-Z]\d{3}|[A-Z]{2}-\d{2})`, 'A123'],
    [String.raw`AB\s{1,3}\d{2}`, 'AB 12'],
    ['.{0,45}.{0,45}.{0,45}', 'a'],
    ['.{0,100}.{0,100}', 'a'],
    [String.raw`\s{0,100}\s{0,100}x`, ' x'],
    [String.raw`\s+\d`, ' 1'],
    [String.raw`\s+X`, ' X'],
    [String.raw`\S+@x\.at`, 'a@x.at'],
    ['.*.{0,100}', 'a'],
    [String.raw`\w+\w{0,99}`, 'a'],
    [String.raw`x{0}|VN-\d+`, 'VN-1'],
    ['(?:a|a)'.repeat(15), 'a'.repeat(15)],
  ];
  const big = 100_000;
  const inputs: Record<string, string> = {
    letters: `${'a'.repeat(big)}!`,
    digits: `${'1'.repeat(big)}!`,
    spaces: `${' '.repeat(big)}x`,
    punctuation: `${'!'.repeat(big)}a`,
    'letter-digit-dash': `${'A1-'.repeat(big / 3)}!`,
    'short words': ` ${'a'.repeat(200)}`.repeat(big / 201),
    'all adversarial texts': Object.values(adversarial).join('\n'),
  };

  for (const [pattern, example] of patterns) {
    const detector = new CustomEntityDetector(
      defineCustomEntityType({ name: 'SOME_NUMBER', description: 'x', examples: [example], pattern }),
    );
    it.each(Object.entries(inputs))(`${pattern.slice(0, 40)}: %s`, (_, text) => {
      const start = performance.now();
      try {
        detector.detect(text);
      } catch (e) {
        // Failing closed is fine, hanging is not.
        expect(e).toBeInstanceOf(PiiShieldError);
      }
      expect(performance.now() - start).toBeLessThan(LIMIT_MS);
    });
  }
});

describe('learned pattern engine matches a backtracking regex engine', () => {
  // ASCII-only patterns and texts, where JavaScript's RegExp has PCRE's semantics; none matches empty.
  const patterns = [
    String.raw`[A-Z]{1,3}-\d{2,4}`,
    '(?:a|ab)(?:c|bcd)',
    'a{0,2}a{1,3}b?',
    '(?:x|xy)(?:y|)z',
    'a+b|a{2}',
    '[^a-]{2,}',
    '(a|b)(c|a)(?:b|)',
    '-?[0-9]{1,3}',
  ];
  const alphabet = ['a', 'b', 'c', 'x', 'y', 'z', '-', '1', '2', ' ', 'A', 'B'];
  let seed = 7;
  const random = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % max;
  };

  it.each(patterns)('%s', (pattern) => {
    const js = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${pattern})(?![\p{L}\p{N}])`, 'gu');
    const compiled = LearnedPattern.compile(pattern);
    expect(compiled).toBeInstanceOf(LearnedPattern);
    for (let i = 0; i < 5000; i++) {
      const text = Array.from({ length: 1 + random(16) }, () => alphabet[random(alphabet.length)]).join('');
      const expected = [...text.matchAll(js)].map((m) => ({ value: m[0], offset: m.index }));
      expect((compiled as LearnedPattern).matchAll(text), JSON.stringify(text)).toEqual(expected);
    }
  });
});
