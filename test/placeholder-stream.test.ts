import { describe, expect, it } from 'vitest';

import { PlaceholderStreamRestorer } from '../src/internal/placeholder-stream.js';
import { restorePlaceholders } from '../src/index.js';

const MAPPING = {
  '⟦PERSON_1⟧': 'Johann Beispielmann',
  '⟦IBAN_1⟧': 'AT61 1904 3002 3457 3201',
  '⟦TAX_NUMBER_12⟧': '46 123/4567',
  '⟦VN2_NUMBER_1⟧': 'VN2-0001',
  '⟦IBAN_\u{1D7CF}⟧': 'astral digit',
};

const restore = (text: string): string => restorePlaceholders(text, MAPPING).text;

function streamed(chunks: readonly string[], maxPending?: number): { out: string; emitted: string[] } {
  const restorer = new PlaceholderStreamRestorer(restore, maxPending);
  const emitted = chunks.map((chunk) => restorer.push(chunk));
  emitted.push(restorer.flush());

  return { out: emitted.join(''), emitted };
}

/** Deterministic PRNG (mulberry32), so a failing split can be reproduced from its seed. */
function random(seed: number): () => number {
  let a = seed;

  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSplit(text: string, next: () => number): string[] {
  const units = [...text];
  const chunks: string[] = [];
  let i = 0;
  while (i < units.length) {
    const size = 1 + Math.floor(next() * 6);
    chunks.push(units.slice(i, i + size).join(''));
    i += size;
  }

  return chunks;
}

describe('PlaceholderStreamRestorer', () => {
  it.each([
    ['canonical, split inside', ['Hallo ⟦PER', 'SON_1⟧!'], 'Hallo Johann Beispielmann!'],
    ['split before the closing bracket', ['⟦IBAN_1', '⟧'], 'AT61 1904 3002 3457 3201'],
    ['ASCII brackets split between them', ['Konto [', '[iban 1]', ']'], 'Konto AT61 1904 3002 3457 3201'],
    ['escaped underscore split after the backslash', ['⟦TAX\\', '_NUMBER\\', '_12⟧'], '46 123/4567'],
    ['learned type with digits', ['⟦VN2', '_NUMBER_', '1⟧'], 'VN2-0001'],
    ['inner whitespace', ['⟦ person ', ' 1 ⟧'], 'Johann Beispielmann'],
    ['unknown placeholder stays', ['⟦PERSON', '_9⟧ und ⟦PERSON_1⟧'], '⟦PERSON_9⟧ und Johann Beispielmann'],
    ['a stray bracket is released at once', ['a [b', ' c'], 'a [b c'],
    ['an opener that cannot become a placeholder', ['⟦ ', '-'], '⟦ -'],
    ['an unclosed placeholder at the end is flushed as it is', ['⟦PERSON_1'], '⟦PERSON_1'],
    ['a single trailing bracket is held', ['x [', '[PERSON_1]]'], 'x Johann Beispielmann'],
    ['an astral digit split between its surrogates', ['⟦IBAN_\u{D835}', '\u{DFCF}⟧'], 'astral digit'],
    ['a lone high surrogate at the end is flushed', ['a\u{D835}'], 'a\u{D835}'],
  ])('%s', (_name, chunks, expected) => {
    expect(streamed(chunks).out).toBe(expected);
  });

  it('never emits part of a placeholder', () => {
    const { emitted } = streamed(['Hallo ⟦', 'PERSON', '_1', '⟧, ', 'bitte ']);

    expect(emitted).toEqual(['Hallo ', '', '', 'Johann Beispielmann, ', 'bitte ', '']);
  });

  it('emits text before a held opener right away', () => {
    const restorer = new PlaceholderStreamRestorer(restore);

    expect(restorer.push('Ihr Konto ⟦IB')).toBe('Ihr Konto ');
    expect(restorer.push('AN_1⟧ ist')).toBe('AT61 1904 3002 3457 3201 ist');
  });

  it('gives up on a candidate that grows beyond the limit', () => {
    const restorer = new PlaceholderStreamRestorer(restore, 16);

    expect(restorer.push('a ⟦PERSON')).toBe('a ');
    expect(restorer.push('     ')).toBe('');
    expect(restorer.push('          ')).toBe('⟦PERSON               ');
    expect(restorer.flush()).toBe('');
  });

  it('holds at most the limit, also for many openers', () => {
    const restorer = new PlaceholderStreamRestorer(restore, 32);
    let held = 0;
    for (let i = 0; i < 200; i++) {
      held += 2;
      held -= restorer.push('[[').length;
      expect(held).toBeLessThanOrEqual(32);
    }
  });

  it('random chunk splits give the same text as restoring the whole answer', () => {
    const texts = [
      'Sehr geehrter ⟦PERSON_1⟧, überweisen Sie auf ⟦IBAN_1⟧ ([[iban 1]]). Steuernummer: ⟦TAX\\_NUMBER\\_12⟧.',
      '[[[PERSON_1]]] ⟦⟦PERSON_1⟧⟧ [[ person  1 ]] ⟦PERSON_9⟧ ⟦PERSON_١⟧ ⟦VN2_NUMBER_1⟧ [x] [[ ]] ⟦ ⟧',
      'Kein Platzhalter, nur [Klammern] und ⟦ andere ⟧ Zeichen: 😀 [[1]] [[a_]] [[A\\_\\_1]] ⟦A__1⟧',
      '⟦PERSON_1⟧⟦IBAN_1⟧[[PERSON_1]][[IBAN 1]]⟦PERSON 1 ⟧[[PERSON\u{A0}1]]',
    ];
    const next = random(20261120);
    for (const text of texts) {
      const expected = restore(text);
      for (let run = 0; run < 300; run++) {
        const chunks = randomSplit(text, next);
        expect(streamed(chunks).out, JSON.stringify(chunks)).toBe(expected);
      }
    }
  });

  it('random texts from placeholder fragments stream like they restore', () => {
    const fragments = [
      '\u{1D7CF}',
      '⟦',
      '⟧',
      '[',
      ']',
      '[[',
      ']]',
      'PERSON',
      'IBAN',
      '_',
      '\\_',
      ' ',
      '1',
      '12',
      '١',
      'x',
      '😀',
      '\n',
    ];
    const next = random(42);
    for (let run = 0; run < 3000; run++) {
      const parts: string[] = [];
      const length = 1 + Math.floor(next() * 20);
      for (let i = 0; i < length; i++) {
        parts.push(fragments[Math.floor(next() * fragments.length)] ?? '');
      }
      const text = parts.join('');
      const chunks = randomSplit(text, next);
      expect(streamed(chunks).out, JSON.stringify(chunks)).toBe(restore(text));
    }
  });
});
