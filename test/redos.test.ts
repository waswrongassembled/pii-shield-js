import { describe, expect, it } from 'vitest';

import {
  CustomEntityDetector,
  defaultDetectors,
  defineCustomEntityType,
  EntityExtractor,
  ModelDetector,
  PhoneDetector,
  PiiShieldError,
} from '../src/index.js';
import { DIGIT, WORD_CHARS } from '../src/internal/pcre.js';
import { FILE_NUMBER_KEYWORDS } from '../src/detectors/file-number.js';
import { PlaceholderStreamRestorer } from '../src/internal/placeholder-stream.js';
import { LearnedPattern } from '../src/learning/learned-pattern.js';
import { isAfterCitation, isAfterFileNumberKeyword } from '../src/model/model-detector.js';

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

describe('validating a learned pattern has a bounded cost', () => {
  // PHP limits each start position only: these took up to 16 s each and would block Node's event loop.
  const cases: [string, string[]][] = [
    ['.{0,45}.{0,45}.{0,45}X', ['aX']],
    ['.{0,99}.{0,99}X', ['aX']],
    [String.raw`\S+@x\.at`, Array.from({ length: 20 }, (_, i) => `${'a'.repeat(i + 1)}@x.at`)],
    [String.raw`\w{0,100}\w{0,100}X`, Array.from({ length: 20 }, (_, i) => `${'a'.repeat(i + 1)}X`)],
  ];

  it.each(cases)('%s finishes within 1.5 s, accepted or rejected', (pattern, examples) => {
    const start = performance.now();
    try {
      defineCustomEntityType({ name: 'SOME_NUMBER', description: 'x', examples, pattern });
    } catch {
      // rejected as too slow is fine
    }
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it('accepts the bounded form of a broad pattern', () => {
    const examples = Array.from({ length: 20 }, (_, i) => `${'a'.repeat(i + 1)}@x.at`);

    expect(() =>
      defineCustomEntityType({ name: 'SOME_NUMBER', description: 'x', examples, pattern: String.raw`\S{1,64}@x\.at` }),
    ).not.toThrow();
  });
});

describe('model detector checks run in bounded time', () => {
  const run = async (text: string, answer: string, options: { keepAuthorityContacts?: boolean } = {}) => {
    const detector = new ModelDetector({
      model: () => Promise.resolve(answer),
      location: 'local',
      chunkSize: 20_000,
      ...options,
    });
    const start = performance.now();
    await detector.detect(text);

    return performance.now() - start;
  };
  const other = (value: string): string => JSON.stringify({ entities: [{ type: 'OTHER', value }] });

  it.each([
    ['citation keywords that split two ways', `§ 1${' Ziff'.repeat(3000)} StVO`, other('StVO')],
    ['citation without an end', `§ 1${' Abs. 2'.repeat(2000)}x StVO`, other('StVO')],
    ['many paragraph signs', `${'§ 1 '.repeat(4000)}StVO`, other('StVO')],
    [
      'file number keyword before blanks',
      `${'Zahl '.repeat(2000)}${' '.repeat(5000)}: A-1`,
      JSON.stringify({ entities: [{ type: 'FILE_NUMBER', value: 'A-1' }] }),
    ],
    ['unclosed reasoning', 'Jan Novák', `${'<think>'.repeat(20_000)}{"entities":[]}`],
    ['trailing punctuation', 'Jan Novák', other(`Jan${'.'.repeat(20_000)}x`)],
    ['salutations', 'Jan Novák', other(`${'Herr '.repeat(5000)}x`)],
    ['law abbreviation lookahead', `§ 1 ${'Ab'.repeat(5000)}`, other('Ab'.repeat(5000))],
    ['many occurrences', 'Jan Novák, '.repeat(1500), other('Jan Novák')],
    ['value of many words', 'a, '.repeat(5000), other('a, '.repeat(3000))],
    [
      'many addresses and e-mails',
      `Magistrat Musterhausen\n${'Lindenweg 12, x@musterhausen.example '.repeat(400)}`,
      JSON.stringify({
        entities: [
          { type: 'ADDRESS', value: 'Lindenweg 12' },
          { type: 'EMAIL', value: 'x@musterhausen.example' },
        ],
      }),
    ],
  ])('%s', async (_, text, answer) => {
    expect(await run(text, answer)).toBeLessThan(LIMIT_MS);
  });

  // PHP's patterns, safe on short inputs only.
  const citation = new RegExp(
    String.raw`§§?[ \t]*\p{Nd}+[a-z]?(?:[ \t]+(?:Abs|lit|Z|Ziff|Satz|Nr|Art)\.?[ \t]*[${WORD_CHARS}]+\)?)*[ \t]+$`,
    'u',
  );
  const keyword = new RegExp(String.raw`(?<![${WORD_CHARS}])${FILE_NUMBER_KEYWORDS}[ \t]*:?[ \t]*$`, 'u');
  let seed = 11;
  const random = (max: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % max;
  };

  it('the citation check equals PHP’s pattern', () => {
    const tokens = [
      '§',
      '§§',
      ' ',
      '\t',
      '1',
      '٣',
      '2a',
      'Abs',
      'Ziff',
      'Z',
      'iff',
      'lit',
      '.',
      ')',
      'x',
      'StVO',
      ',',
      'ä',
    ];
    for (let i = 0; i < 20_000; i++) {
      const text = Array.from({ length: 1 + random(10) }, () => tokens[random(tokens.length)]).join('');
      expect(isAfterCitation(text), JSON.stringify(text)).toBe(citation.test(text));
    }
  });

  it('the file number keyword check equals PHP’s pattern', () => {
    const tokens = ['Zahl', 'GZ', 'Gz.', 'Az.', 'Kunden-Nr', '.', ':', ' ', '\t', 'x', 'ä', 'Aktenzeichen'];
    for (let i = 0; i < 20_000; i++) {
      const text = Array.from({ length: 1 + random(6) }, () => tokens[random(tokens.length)]).join('');
      expect(isAfterFileNumberKeyword(text), JSON.stringify(text)).toBe(keyword.test(text));
    }
  });
});

describe('streaming restore runs in bounded time', () => {
  const big = 100_000;
  const inputs: Record<string, string> = {
    'unclosed placeholders': '[[A 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1 '.repeat(big / 40),
    'long unclosed placeholders': `[[A${' 1'.repeat(500)}`.repeat(big / 1000),
    'brackets only': '['.repeat(big),
    'brackets before an opener': `${'['.repeat(big)}⟦`,
    'opener and spaces': `⟦${' '.repeat(big)}`,
    'escaped underscores': `⟦A${'\\_A'.repeat(big / 3)}`,
    'complete placeholders': '⟦PERSON_1⟧'.repeat(big / 10),
  };

  it.each(Object.entries(inputs))('%s, in one chunk and in chunks of 3', (_, text) => {
    const start = performance.now();
    const whole = new PlaceholderStreamRestorer((t) => t);
    expect(whole.push(text) + whole.flush()).toBe(text);
    const chunked = new PlaceholderStreamRestorer((t) => t);
    let out = '';
    for (let i = 0; i < text.length; i += 3) {
      out += chunked.push(text.slice(i, i + 3));
    }
    expect(out + chunked.flush()).toBe(text);
    expect(performance.now() - start).toBeLessThan(LIMIT_MS * 2);
  });
});
