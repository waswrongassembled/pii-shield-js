import { inspect } from 'node:util';

import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import { detectionModel } from '../src/ai-sdk/index.js';
import {
  customEntityTypeFromJSON,
  defaultDetectors,
  defineCustomEntityType,
  DetectionError,
  EntityExtractor,
  EntityLearner,
  EntityType,
  InMemoryCustomEntityStore,
  InMemoryVault,
  type ModelCallOptions,
  ModelDetector,
  type ModelDetectorOptions,
  type ModelPrompt,
  NullPiiShield,
  PiiMasker,
  PiiShield,
  PiiShieldError,
} from '../src/index.js';
import { expectedEntity, loadFixture } from './support/fixtures.js';

/** A fake model: answers in call order, then '{"entities":[]}'; records every prompt. Never calls a provider. */
function fakeModel(answers: (string | (() => never))[] | ((prompt: ModelPrompt) => string)) {
  const calls: ModelPrompt[] = [];
  const queue = Array.isArray(answers) ? [...answers] : [];
  const generate = (prompt: ModelPrompt, options: ModelCallOptions): Promise<string> => {
    calls.push(prompt);
    options.signal.throwIfAborted();
    if (typeof answers === 'function') {
      return Promise.resolve(answers(prompt));
    }
    const answer = queue.shift() ?? '{"entities":[]}';

    return typeof answer === 'function' ? Promise.resolve().then(answer) : Promise.resolve(answer);
  };

  return { generate, calls, sent: () => calls.map((c) => c.user) };
}

function makeDetector(
  answer: string | string[] | ((prompt: ModelPrompt) => string),
  options: Partial<ModelDetectorOptions> = {},
) {
  const model = fakeModel(typeof answer === 'string' ? [answer] : answer);
  const detector = new ModelDetector({
    model: { name: 'test-model', generate: model.generate },
    location: 'local',
    ...options,
  });

  return { detector, model };
}

const TEXT = 'Vážený pan Jan Novák,\nčíslo pasu CZ1234567, Lindenweg 12\n6900 Bregenz. Jan Novák zahlt 110,00 Euro.';
const fixture = loadFixture('model');

/** PHP trims the bytes of „“”‚‘’«», not the characters, and then drops the broken value (docs/DEVIATIONS.md). */
const BYTE_TRIM: Record<string, string[]> = {
  'value ending in ř (byte trim)': ['Jan Kovář'],
  'value ending in р (byte trim)': ['Александр'],
  'value starting with € (byte trim)': ['€12'],
  'value ending in ę (byte trim)': ['Mię'],
};

describe('ModelDetector: PHP fixtures', () => {
  it.each(fixture.detect.map((c) => [c.case, c] as const))('%s', async (name, c) => {
    const model = fakeModel(
      c.answers.map((a) =>
        a === '!throw'
          ? () => {
              throw new Error('400 Bad Request: input "Johann Beispielmann" is invalid');
            }
          : a,
      ),
    );
    const detector = new ModelDetector({
      model: { name: 'test-model', generate: model.generate },
      location: 'local',
      learnedTypes: new InMemoryCustomEntityStore(c.learned.map((t) => customEntityTypeFromJSON(t))),
      chunkSize: c.chunkSize,
      keepAuthorityContacts: c.keepAuthorityContacts,
    });

    const outcome = detector.detect(c.text);

    if (c.error !== undefined) {
      const error = await outcome.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DetectionError);
      // PHP names the exception class (RuntimeException), the port the error's name.
      expect((error as Error).message).toBe(c.error.message.replace('(RuntimeException)', '(Error)'));
    } else if (name in BYTE_TRIM) {
      expect((await outcome).map((e) => e.value)).toEqual(BYTE_TRIM[name]);
      expect(c.result).toEqual([]);
    } else {
      expect(await outcome).toEqual(c.result.map((e) => expectedEntity(c.text, e)));
    }
    expect(model.sent()).toEqual(c.sent);
    expect([...new Set(model.calls.map((p) => p.system))]).toEqual(c.systems);
  });

  it.each(fixture.prompts.map((p) => [p.case, p] as const))('system prompt: %s', async (_, p) => {
    const { detector, model } = detector2(
      new InMemoryCustomEntityStore(p.learned.map((t) => customEntityTypeFromJSON(t))),
    );
    await detector.detect('Jan Novák');

    expect(model.calls[0]?.system).toBe(p.system);
  });

  it.each(Object.entries(fixture.constructor))('constructor: %s', (name, outcome) => {
    const generate = () => Promise.resolve('');
    const options: Record<string, ModelDetectorOptions> = {
      'chunk size too small': { model: generate, location: 'local', chunkSize: 99 },
      'empty model name': { model: { name: ' ', generate }, location: 'local' },
      'external without acknowledgement': { model: generate, location: 'external' },
    };

    // PHP names its constructor parameter ($acknowledgeExternalTransfer), the port its option.
    const option = options[name];
    if (option === undefined) {
      throw new Error(`No options for ${name}`);
    }
    expect(() => new ModelDetector(option)).toThrow(
      outcome.error?.message.replace('$acknowledgeExternalTransfer', 'acknowledgeExternalTransfer'),
    );
  });
});

function detector2(learned: ModelDetectorOptions['learnedTypes']) {
  return makeDetector('{"entities":[]}', { learnedTypes: learned ?? [] });
}

describe('ModelDetector (ModelDetectorTest)', () => {
  it('grounds findings in the text with UTF-16 offsets', async () => {
    const text = `😀 ${TEXT}`;
    const entities = await makeDetector(
      '{"entities":[{"type":"PERSON","value":"Jan Novák"},{"type":"ID_NUMBER","value":"CZ1234567"}]}',
    ).detector.detect(text);

    expect(entities.map((e) => [e.type, e.value])).toEqual([
      ['PERSON', 'Jan Novák'],
      ['ID_NUMBER', 'CZ1234567'],
      ['PERSON', 'Jan Novák'],
    ]);
    for (const e of entities) {
      expect(text.slice(e.offset, e.offset + e.value.length)).toBe(e.value);
      expect(e.detector).toBe('model');
      expect(e.confidence).toBe(0.85);
    }
  });

  it('keeps provider errors out of the message', async () => {
    const { detector } = makeDetector(() => {
      throw new Error('400 Bad Request: input "Johann Beispielmann, SVNR 4568 150392" is invalid');
    });

    const error = await detector.detect(TEXT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DetectionError);
    expect(error).toBeInstanceOf(PiiShieldError);
    expect((error as DetectionError).code).toBe('DETECTION_MODEL_UNREACHABLE');
    expect((error as Error).message).toBe('The detection model "test-model" could not be reached (Error).');
    expect(String((error as Error).cause)).toContain('Beispielmann'); // for server logs
  });

  it('keeps the unusable answer out of logs', async () => {
    const { detector } = makeDetector(['Herr Johann Beispielmann', 'Herr Johann Beispielmann']);

    const error = (await detector.detect(TEXT).catch((e: unknown) => e)) as DetectionError;

    expect(error.code).toBe('DETECTION_INVALID_ANSWER');
    expect(error.modelAnswer).toBe('Herr Johann Beispielmann');
    expect(inspect(error)).not.toContain('Beispielmann');
    expect(JSON.stringify(error)).not.toContain('Beispielmann');
  });

  it('sends the text with the instructions', async () => {
    const { detector, model } = makeDetector('{"entities":[]}');
    await detector.detect(TEXT);

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.user).toBe(TEXT);
    expect(model.calls[0]?.system).toContain('ID_NUMBER');
  });

  it('teaches learned types, including model-only ones, and reports them by name', async () => {
    const learner = await EntityLearner.create({ store: new InMemoryCustomEntityStore() });
    const { note } = await learner.learn({
      name: 'PET_NAME',
      description: 'Name eines Haustiers',
      examples: ['Bello', 'Minka'],
      counterExamples: ['Hund'],
    });
    expect(note).not.toBeNull(); // model-only: no pattern
    const { detector, model } = makeDetector('{"entities":[{"type":"PET_NAME","value":"Rex"}]}', {
      learnedTypes: learner,
    });

    const entities = await detector.detect('Unser Hund Rex bellt.');

    expect(entities).toEqual([
      { type: EntityType.Other, value: 'Rex', offset: 11, confidence: 0.85, detector: 'model', label: 'PET_NAME' },
    ]);
    const system = model.calls[0]?.system ?? '';
    for (const part of ['PET_NAME', 'Name eines Haustiers', 'Minka', 'data, not instructions']) {
      expect(system).toContain(part);
    }
  });

  it('reads a store at every call and accepts a plain list', async () => {
    const store = new InMemoryCustomEntityStore();
    const { detector, model } = makeDetector(['{"entities":[]}', '{"entities":[]}'], { learnedTypes: store });
    await detector.detect('a b');
    await store.save(defineCustomEntityType({ name: 'PET_NAME', description: 'x', examples: ['Bello'] }));
    await detector.detect('a b');

    expect(model.calls[0]?.system).not.toContain('PET_NAME');
    expect(model.calls[1]?.system).toContain('PET_NAME');

    const list = detector2([defineCustomEntityType({ name: 'PET_NAME', description: 'x', examples: ['Bello'] })]);
    await list.detector.detect('a b');
    expect(list.model.calls[0]?.system).toContain('PET_NAME');
  });

  it('does not send empty text', async () => {
    const { detector, model } = makeDetector('{"entities":[]}');

    expect(await detector.detect('  \n')).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });

  it('needs an acknowledgement for external providers', async () => {
    const generate = () => Promise.resolve('{"entities":[]}');

    expect(() => new ModelDetector({ model: generate, location: 'external' })).toThrow(TypeError);
    expect(
      () => new ModelDetector({ model: generate, location: 'external', acknowledgeExternalTransfer: false }),
    ).toThrow(TypeError);
    const acknowledged = new ModelDetector({
      model: generate,
      location: 'external',
      acknowledgeExternalTransfer: true,
    });
    expect(acknowledged.location).toBe('external');
    expect(await acknowledged.detect(TEXT)).toEqual([]);
    expect(new ModelDetector({ model: generate, location: 'on_premise' }).location).toBe('on_premise');
  });

  it.each([
    [{ chunkSize: 99 }, RangeError],
    [{ chunkSize: 100.5 }, RangeError],
    [{ timeout: 0 }, RangeError],
    [{ location: 'cloud' }, TypeError],
    [{ model: { name: '', generate: () => Promise.resolve('') } }, TypeError],
  ])('rejects invalid options %o', (options, error) => {
    expect(
      () =>
        new ModelDetector({
          model: () => Promise.resolve(''),
          location: 'local',
          ...(options as Partial<ModelDetectorOptions>),
        }),
    ).toThrow(error);
  });

  it('names a function model after the function', async () => {
    const llama = (): Promise<string> => Promise.resolve('kaputt');
    const error = await new ModelDetector({ model: llama, location: 'local' }).detect('a b').catch((e: unknown) => e);

    expect((error as Error).message).toBe('The detection model "llama" did not return the expected JSON.');
  });

  it('fails closed when the model returns no string', async () => {
    const generate = () => Promise.resolve(42 as unknown as string);
    const error = await new ModelDetector({ model: { name: 'm', generate }, location: 'local' })
      .detect('a b')
      .catch((e: unknown) => e);

    expect((error as Error).message).toBe('The detection model "m" could not be reached (TypeError).');
  });

  it('chunks long texts within the size, sends every paragraph whole and stops at the limit', async () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Absatz ${String(i + 1)}: ${'Text '.repeat(30)}`);
    const { detector, model } = makeDetector([], { chunkSize: 500 });
    await detector.detect(paragraphs.join('\n\n'));

    expect(model.calls.length).toBeGreaterThan(1);
    for (const chunk of model.sent()) {
      expect([...chunk].length).toBeLessThanOrEqual(500);
    }
    for (const paragraph of paragraphs) {
      expect(model.sent().some((chunk) => chunk.includes(paragraph))).toBe(true);
    }
  });

  it('sends a value at any cut inside a paragraph whole', async () => {
    const words = Array<string>(200).fill('Wort');
    for (let position = 0; position < 200; position += 7) {
      const text = [...words.slice(0, position), 'Maria Musterfrau', ...words.slice(position)].join(' ');
      const { detector, model } = makeDetector([], { chunkSize: 300 });
      await detector.detect(text);

      expect(model.calls.length).toBeGreaterThan(1);
      expect(model.sent().some((chunk) => chunk.includes('Maria Musterfrau'))).toBe(true);
    }
  });

  it('fails before anything is sent when there are too many chunks', async () => {
    const { detector, model } = makeDetector([], { chunkSize: 100 });

    const error = (await detector.detect('Wort '.repeat(20 * ModelDetector.MAX_CHUNKS)).catch((e: unknown) => e)) as
      DetectionError | undefined;

    expect(error?.code).toBe('DETECTION_TEXT_TOO_LONG');
    expect(error?.message).toContain('too long');
    expect(model.calls).toHaveLength(0);
  });

  it('advances a whole step per chunk in text without spaces and rejects huge texts fast', async () => {
    const { detector, model } = makeDetector([], { chunkSize: 1_000 });
    let start = performance.now();
    await detector.detect('x'.repeat(20_000));
    expect(model.calls.length).toBeLessThanOrEqual(30);
    expect(performance.now() - start).toBeLessThan(1_000);

    const small = makeDetector([], { chunkSize: 100 });
    start = performance.now();
    await expect(small.detector.detect('x'.repeat(5_000_000))).rejects.toThrow(DetectionError);
    expect(performance.now() - start).toBeLessThan(500);
    expect(small.model.calls).toHaveLength(0);
  });
});

describe('ModelDetector: concurrency, cancellation, timeout', () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Absatz ${String(i + 1)}: ${'Text '.repeat(30)}`).join(
    '\n\n',
  );

  it('keeps at most four calls in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const generate = async (): Promise<string> => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;

      return '{"entities":[]}';
    };
    await new ModelDetector({ model: generate, location: 'local', chunkSize: 300 }).detect(paragraphs);

    expect(max).toBe(4);
  });

  it('aborts the other calls of a batch when one fails', async () => {
    const signals: AbortSignal[] = [];
    let call = 0;
    const generate = (_: ModelPrompt, { signal }: ModelCallOptions): Promise<string> => {
      signals.push(signal);
      return ++call === 2 ? Promise.reject(new Error('down')) : new Promise<string>(() => undefined);
    };

    await expect(
      new ModelDetector({ model: generate, location: 'local', chunkSize: 300 }).detect(paragraphs),
    ).rejects.toThrow('could not be reached (Error)');
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('rejects with the caller’s reason when aborted, also if the model ignores the signal', async () => {
    const controller = new AbortController();
    const generate = (): Promise<string> => {
      controller.abort(new Error('user cancelled'));

      return new Promise<string>(() => undefined);
    };

    await expect(
      new ModelDetector({ model: generate, location: 'local' }).detect(TEXT, { signal: controller.signal }),
    ).rejects.toThrow('user cancelled');
    await expect(
      new ModelDetector({ model: generate, location: 'local' }).detect(TEXT, { signal: controller.signal }),
    ).rejects.toThrow('user cancelled');
  });

  it('fails closed on timeout', async () => {
    const generate = (): Promise<string> => new Promise<string>(() => undefined);
    const error = (await new ModelDetector({ model: generate, location: 'local', timeout: 20 })
      .detect(TEXT)
      .catch((e: unknown) => e)) as DetectionError;

    expect(error.code).toBe('DETECTION_MODEL_UNREACHABLE');
    expect(error.message).toBe('The detection model "generate" could not be reached (TimeoutError).');
  });
});

describe('async pipeline', () => {
  const answer = '{"entities":[{"type":"PERSON","value":"Jan Novák"},{"type":"ID_NUMBER","value":"CZ1234567"}]}';

  it('refuses async detectors in the sync APIs before anything is sent', () => {
    const { detector: model, model: fake } = makeDetector(answer);

    expect(() => new EntityExtractor({ detectors: [model] }).extract(TEXT)).toThrow(TypeError);
    expect(() => new PiiShield({ detectors: [model] }).redact(TEXT)).toThrow(/extractAsync\(\), redactAsync\(\)/);
    expect(() => new PiiMasker({ detectors: [model] }).mask(TEXT)).toThrow(TypeError);
    expect(fake.calls).toHaveLength(0);
    expect(new EntityExtractor({ detectors: [model] }).isAsync).toBe(true);
    expect(new EntityExtractor().isAsync).toBe(false);
  });

  it('refuses a detector function that returns a Promise', () => {
    const detect = (() => Promise.resolve([])) as unknown as () => [];

    expect(() => new EntityExtractor({ detectors: [detect] }).extract(TEXT)).toThrow(/returned a Promise/);
  });

  it('redacts with the model next to the regex detectors', async () => {
    const { detector: model } = makeDetector(answer);
    const shield = new PiiShield({ detectors: [...defaultDetectors(), model] });

    const result = await shield.redactAsync(TEXT);

    expect(result.redactedText).toBe(
      'Vážený pan ⟦PERSON_1⟧,\nčíslo pasu ⟦ID_NUMBER_1⟧, Lindenweg 12\n6900 Bregenz. ⟦PERSON_1⟧ zahlt 110,00 Euro.',
    );
    expect(shield.restore(result.redactedText, result).text).toBe(TEXT);
  });

  it('gives the same result as the sync API for sync detectors', async () => {
    const shield = new PiiShield();

    expect(await shield.redactAsync(TEXT)).toEqual(shield.redact(TEXT));
    expect(await new PiiMasker().maskAsync(TEXT)).toBe(new PiiMasker().mask(TEXT));
    expect(await new NullPiiShield().redactAsync(TEXT)).toEqual(new NullPiiShield().redact(TEXT));
  });

  it('stores model findings in the vault and masks with them', async () => {
    const shield = new PiiShield({ detectors: [makeDetector(answer).detector], vault: new InMemoryVault() });
    const result = await shield.redactToVault(TEXT);

    expect(result.mapping).toEqual({ '⟦PERSON_1⟧': 'Jan Novák', '⟦ID_NUMBER_1⟧': 'CZ1234567' });
    expect((await shield.restoreFromVault(result.redactedText, result.vaultId)).text).toBe(TEXT);
    expect(await new PiiMasker({ detectors: [makeDetector(answer).detector] }).maskAsync('Jan Novák')).toBe('[PERSON]');
  });

  it('sees the normalised text and reports the original characters', async () => {
    const { detector: model, model: fake } = makeDetector('{"entities":[{"type":"ADDRESS","value":"Lindenweg 12"}]}');
    const entities = await new EntityExtractor({ detectors: [model] }).extractAsync('Lindenweg 12\r\n6900 Bregenz');

    expect(fake.sent()).toEqual(['Lindenweg 12 \n6900 Bregenz']);
    expect(entities.map((e) => e.value)).toEqual(['Lindenweg 12\r\n6900 Bregenz']);
  });

  it('passes the signal on', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { detector: model, model: fake } = makeDetector(answer);

    await expect(
      new PiiShield({ detectors: [model] }).redactAsync(TEXT, { signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('AI SDK adapter', () => {
  it('calls generateText with the instructions, the chunk and the signal', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: {
        content: [{ type: 'text', text: '{"entities":[{"type":"PERSON","value":"Jan Novák"}]}' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const detector = new ModelDetector({ model: detectionModel(model, { temperature: 0 }), location: 'local' });

    const entities = await detector.detect(TEXT);

    expect(entities.map((e) => e.value)).toEqual(['Jan Novák', 'Jan Novák']);
    const call = model.doGenerateCalls[0];
    expect(call?.temperature).toBe(0);
    expect(call?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(call?.prompt)).toContain('You find personal data');
    expect(call?.prompt[0]?.role).toBe('system');
    expect(JSON.stringify(call?.prompt[1])).toContain('Jan Novák');
  });

  it('names the model in errors', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-model',
      doGenerate: () => Promise.reject(new Error('down')),
    });
    const detector = new ModelDetector({
      model: detectionModel(model, { maxRetries: 0 }),
      location: 'local',
    });

    await expect(detector.detect(TEXT)).rejects.toThrow(/^The detection model "mock-model" could not be reached/);
  });
});
