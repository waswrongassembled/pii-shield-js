import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DetectionError,
  EntityExtractor,
  EntityLearner,
  EntityType,
  InMemoryCustomEntityStore,
  KnownValuesDetector,
  PiiMasker,
  PiiShield,
} from '../src/index.js';
import type { ServiceResponse } from '../src/server/index.js';
import { loadFixture } from './support/fixtures.js';
import { serviceApi, TOKEN } from './support/service.js';

const person = (value: string) => ({ value, type: EntityType.Person });
const redact = (text: string, knownValues: { value: string; type: EntityType }[]) =>
  new PiiShield({ knownValues }).redact(text).redactedText;

describe('KnownValuesDetector', () => {
  it('finds a known value regardless of case', () => {
    expect(redact('JOHANNA WEISSGERBER schrieb an johanna weißgerber.', [person('Johanna Weißgerber')])).toBe(
      '⟦PERSON_1⟧ schrieb an ⟦PERSON_2⟧.',
    );
  });

  it('finds umlauts written as umlaut, as ae/oe/ue, in capitals and decomposed', () => {
    const text = [
      'Jürgen Müller',
      'JÜRGEN MÜLLER',
      'Juergen Mueller',
      'JUERGEN MUELLER',
      'Jürgen Müller',
      'Jürgen Mueller',
    ].join(' / ');
    const result = new PiiShield({ knownValues: [person('Jürgen Müller')] }).redact(text);

    expect(result.entities).toHaveLength(6);
    expect(result.redactedText).not.toMatch(/J(ü|ü|ue|Ü|UE)rgen/iu);
  });

  it('matches the transcription in the other direction and ß as ss', () => {
    expect(
      redact('Frau Schoeller und Frau Schöller, Weissgerber und Weißgerber', [
        person('Schoeller'),
        person('Weissgerber'),
      ]),
    ).not.toMatch(/Sch(oe|ö)ller|Wei(ss|ß)gerber/u);
  });

  it('only matches whole words: a short name does not hit longer words', () => {
    const result = new PiiShield({ knownValues: [person('Ali')] }).redact('Alibi, Kalium, Alis Rad, ALI und Ali. Bali');

    expect(result.redactedText).toBe('Alibi, Kalium, Alis Rad, ⟦PERSON_1⟧ und ⟦PERSON_2⟧. Bali');
  });

  it('respects word boundaries for digits too', () => {
    expect(redact('Kunde 47110, Kunde 4711, Kunde 14711', [{ value: '4711', type: EntityType.FileNumber }])).toBe(
      'Kunde 47110, Kunde ⟦FILE_NUMBER_1⟧, Kunde 14711',
    );
  });

  it('matches multi-word values across line breaks, repeated and no-break spaces', () => {
    const result = new PiiShield({ knownValues: [person('Max Mustermann')] }).redact(
      'Max\nMustermann, Max  Mustermann, Max Mustermann, Max\r\nMustermann',
    );

    expect(result.entities).toHaveLength(4);
    expect(result.redactedText).not.toContain('Mustermann');
  });

  it('treats regex characters in values literally', () => {
    expect(redact('Firma A.B. (Bonn) und Firma AxB (Bonn)', [{ value: 'A.B. (Bonn)', type: EntityType.Other }])).toBe(
      'Firma ⟦OTHER_1⟧ und Firma AxB (Bonn)',
    );
  });

  it('gives each value its type and the same placeholder for repeated occurrences', () => {
    const result = new PiiShield({
      knownValues: [person('Erika Musterfrau'), { value: 'KD-99812', type: EntityType.FileNumber }],
    }).redact('Erika Musterfrau, Kundennummer KD-99812. Gruß, erika musterfrau. KD-99812');

    expect(result.redactedText).toBe('⟦PERSON_1⟧, Kundennummer ⟦FILE_NUMBER_1⟧. Gruß, ⟦PERSON_2⟧. ⟦FILE_NUMBER_1⟧');
  });

  it('also covers the surname of a known full name (propagation)', () => {
    expect(redact('Erika Musterfrau zahlt. Frau Musterfrau bestätigt.', [person('Erika Musterfrau')])).not.toContain(
      'Musterfrau',
    );
  });
});

describe('known values and rule findings overlap cleanly', () => {
  const noNesting = (text: string) => {
    expect(text).not.toMatch(/⟦[^⟧]*⟦/u);
  };

  it('a known value inside a longer rule finding gives one placeholder', () => {
    const result = new PiiShield({ knownValues: [person('Mustermann')] }).redact(
      'Sehr geehrter Herr Max Mustermann,\nwir schreiben Ihnen.',
    );

    noNesting(result.redactedText);
    expect(result.redactedText).not.toContain('Mustermann');
    expect(result.entities.filter((e) => e.type === EntityType.Person)).toHaveLength(1);
  });

  it('a known value covering a rule finding wins as the longer span', () => {
    const result = new PiiShield({
      knownValues: [{ value: 'Max Mustermann Immobilien', type: EntityType.Other }],
    }).redact('Sehr geehrter Herr Max Mustermann Immobilien, IBAN DE89 3704 0044 0532 0130 00.');

    noNesting(result.redactedText);
    expect(result.redactedText).not.toContain('Mustermann');
    expect(result.redactedText).toContain('⟦IBAN_1⟧');
  });

  it('a known value equal to a rule finding gives a single placeholder', () => {
    const result = new PiiShield({
      knownValues: [{ value: 'DE89 3704 0044 0532 0130 00', type: EntityType.Iban }],
    }).redact('IBAN DE89 3704 0044 0532 0130 00');

    expect(result.redactedText).toBe('IBAN ⟦IBAN_1⟧');
    expect(result.entities).toHaveLength(1);
  });

  it('partially overlapping spans never break a placeholder and restore gives the text back', () => {
    const text = 'Herr Max Mustermann-Schulz, Musterweg 5, 53111 Bonn; Schulz Bonn GmbH';
    const shield = new PiiShield({
      knownValues: [
        { value: 'Schulz Bonn GmbH', type: EntityType.Other },
        { value: 'Mustermann-Schulz, Musterweg', type: EntityType.Other },
      ],
    });
    const result = shield.redact(text);

    noNesting(result.redactedText);
    expect(result.redactedText).not.toMatch(/Mustermann|Schulz/u);
    expect(shield.restore(result.redactedText, result).text).toBe(text);
  });

  it('known values win over the allowlist (fail closed)', () => {
    const result = new PiiShield({ allowlist: ['Ali'], knownValues: [person('Ali')] }).redact('Ali kommt.');

    expect(result.redactedText).toBe('⟦PERSON_1⟧ kommt.');
  });

  it('works the same in PiiMasker and EntityExtractor', () => {
    expect(new PiiMasker({ knownValues: [person('Ali')] }).mask('Ali und Alibi')).toBe('[PERSON] und Alibi');
    expect(new EntityExtractor({ knownValues: [person('Ali')] }).extract('Ali').map((e) => e.detector)).toEqual([
      'known-values',
    ]);
  });
});

describe('without knownValues nothing changes', () => {
  const letters = loadFixture('letters').letters.filter((l) => l.expected.detection !== 'model');

  it.each(letters)('$name', ({ text }) => {
    const plain = new PiiShield().redact(text);
    const empty = new PiiShield({ knownValues: [] }).redact(text);

    expect(empty.redactedText).toBe(plain.redactedText);
    expect(empty.entities).toEqual(plain.entities);
  });

  it('a known value that does not occur adds nothing', () => {
    const result = new PiiShield({ knownValues: [person('Quokka Nichtda')] }).redact('Hallo Welt.');

    expect(result.redactedText).toBe('Hallo Welt.');
    expect(Object.keys(result.mapping)).toEqual([]);
  });
});

describe('validation never echoes a value', () => {
  const SECRET = 'Quokkaleinberger';
  const thrown = (values: unknown): Error => {
    try {
      new KnownValuesDetector(values as Iterable<{ value: string; type: EntityType }>);
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected a TypeError');
  };

  it.each([
    ['an unknown type', [{ value: SECRET, type: 'NAME' }]],
    ['a missing type', [{ value: SECRET }]],
    ['a value that is not a string', [{ value: 42, type: 'PERSON' }]],
    ['a value shorter than 2 characters', [{ value: ' Q ', type: 'PERSON' }]],
    ['a value longer than 200 characters', [{ value: SECRET.repeat(20), type: 'PERSON' }]],
    ['too many values', Array.from({ length: 501 }, (_, i) => ({ value: `${SECRET}${String(i)}`, type: 'PERSON' }))],
    ['an entry that is not an object', [SECRET]],
  ])('%s', (_, values) => {
    const error = thrown(values);

    expect(error).toBeInstanceOf(TypeError);
    expect(`${error.message} ${String(error.stack)}`).not.toContain(SECRET);
    expect(error.message).not.toContain('Quokka');
  });

  it('the detector does not reveal its values when serialized or inspected', () => {
    const detector = new KnownValuesDetector([person(SECRET)]);

    expect(JSON.stringify(detector)).not.toContain(SECRET);
    expect(inspect(detector, { depth: 10, showHidden: true })).not.toContain(SECRET);
    expect(String(detector)).not.toContain(SECRET);
  });
});

describe('ServiceApi knownValues', () => {
  const MARKER = 'Quokkaleinberger';
  const errors: unknown[] = [];
  const store = new InMemoryCustomEntityStore();
  const api = serviceApi({
    learner: new EntityLearner({ store }),
    onError: (e) => errors.push(e),
    modelDetector: () => ({
      async: true as const,
      detect: () => Promise.reject(new DetectionError('provider down', 'DETECTION_MODEL_UNREACHABLE')),
    }),
  });
  const call = (path: string, body: Record<string, unknown>): Promise<ServiceResponse> =>
    api.handle({ method: 'POST', path, body, authorization: `Bearer ${TOKEN}`, remoteAddress: '10.0.0.5' });

  const consoleCalls: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args.map((a) => inspect(a, { depth: 10 })).join(' '));
    });
  }
  afterEach(() => {
    expect(consoleCalls.join('\n')).not.toContain(MARKER);
  });

  it('redacts a known value; the response never contains it, restore gives it back', async () => {
    const response = await call('/v1/redact', {
      text: `Termin mit ${MARKER} am Montag.`,
      knownValues: [{ value: MARKER, type: 'PERSON' }],
    });

    expect(response.status).toBe(200);
    expect(response.body?.['text']).toBe('Termin mit ⟦PERSON_1⟧ am Montag.');
    expect(JSON.stringify(response.body)).not.toContain(MARKER);

    const restored = await call('/v1/restore', { text: 'Hallo ⟦PERSON_1⟧', vaultId: response.body?.['vaultId'] });
    expect(restored.body?.['text']).toBe(`Hallo ${MARKER}`);
  });

  it('mask takes knownValues as well', async () => {
    const response = await call('/v1/mask', {
      text: `${MARKER} kam.`,
      knownValues: [{ value: MARKER, type: 'PERSON' }],
    });

    expect(response).toEqual({ status: 200, body: { text: '[PERSON] kam.' } });
  });

  it('knownValues apply even when "types" leaves out their type', async () => {
    const response = await call('/v1/redact', {
      text: `${MARKER} kam.`,
      types: ['IBAN'],
      knownValues: [{ value: MARKER, type: 'PERSON' }],
    });

    expect(response.body?.['text']).toBe('⟦PERSON_1⟧ kam.');
  });

  it.each([
    ['not a list', MARKER],
    ['an entry that is not an object', [MARKER]],
    ['an unknown type', [{ value: MARKER, type: 'NAME' }]],
    ['a value that is not a string', [{ value: 7, type: 'PERSON' }]],
    ['a value that is too short', [{ value: 'Q', type: 'PERSON' }]],
    ['a value that is too long', [{ value: MARKER.repeat(20), type: 'PERSON' }]],
  ])('rejects %s with 400 and without echoing the value', async (_, knownValues) => {
    const response = await call('/v1/redact', { text: `${MARKER} kam.`, knownValues });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(MARKER);
    expect(JSON.stringify(response.body)).not.toContain('Quokka');
  });

  it('errors reported to onError never contain the value', async () => {
    errors.length = 0;
    const response = await call('/v1/redact', {
      text: `${MARKER} kam.`,
      detection: 'both',
      knownValues: [{ value: MARKER, type: 'PERSON' }],
    });

    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain(MARKER);
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(inspect(e, { depth: 10, showHidden: true })).not.toContain(MARKER);
      expect(String((e as Error).stack)).not.toContain(MARKER);
    }
  });

  it('known values are not learned or kept: the next request without them leaves the value alone', async () => {
    await call('/v1/redact', { text: `${MARKER} kam.`, knownValues: [{ value: MARKER, type: 'PERSON' }] });

    expect(await store.all()).toEqual([]);
    const response = await call('/v1/redact', { text: `${MARKER} kam.` });
    expect(response.body?.['text']).toBe(`${MARKER} kam.`);
  });
});
