import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  customEntityTypeFromJSON,
  defaultDetectors,
  defineCustomEntityType,
  EntityExtractor,
  EntityLearner,
  InMemoryCustomEntityStore,
  JsonFileCustomEntityStore,
  KeyValueCustomEntityStore,
  LearnedTypesDetector,
  LearningError,
  PiiMasker,
  PiiShield,
  withoutExamples,
} from '../src/index.js';
import { instructions } from '../src/model/prompt.js';
import { serviceFromEnv } from '../src/server/config.js';

// Synthetic values only.
const POLICY = {
  name: 'POLICY_NUMBER',
  description: 'Synthetische Polizzennummer',
  examples: ['PN-2026-000417', 'PN-2025-998812'],
  counterExamples: ['PN-12'],
};
const PET = { name: 'PET_NAME', description: 'Synthetischer Haustiername', examples: ['Bello', 'Minka'] };
const TEXT = 'Polizze PN-2026-123456, Kontakt max@example.com';

describe('withoutExamples()', () => {
  it('keeps name, description and pattern, and detection by the pattern', () => {
    const type = withoutExamples(defineCustomEntityType({ ...POLICY, pattern: String.raw`PN-\d{4}-\d{6}` }));

    expect(JSON.parse(JSON.stringify(type))).toEqual({
      name: 'POLICY_NUMBER',
      description: 'Synthetische Polizzennummer',
      examples: [],
      counterExamples: [],
      pattern: String.raw`PN-\d{4}-\d{6}`,
    });
    expect(Object.isFrozen(type)).toBe(true);
    expect(new PiiShield({ detectors: [new LearnedTypesDetector([type])] }).redact(TEXT).redactedText).toBe(
      'Polizze ⟦POLICY_NUMBER_1⟧, Kontakt max@example.com',
    );
  });

  it('refuses model-only types without naming their examples', () => {
    const type = defineCustomEntityType(PET);
    const error = (() => {
      try {
        withoutExamples(type);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(LearningError);
    expect((error as Error).message).not.toMatch(/Bello|Minka/);
  });

  it('still validates the pattern', () => {
    expect(() =>
      withoutExamples({
        ...defineCustomEntityType({ ...POLICY, pattern: String.raw`PN-\d{4}-\d{6}` }),
        pattern: '(a+)+',
      }),
    ).toThrow(LearningError);
  });

  it('is read back by customEntityTypeFromJSON(); model-only types still need an example', () => {
    expect(
      customEntityTypeFromJSON({
        name: 'POLICY_NUMBER',
        description: 'x',
        examples: [],
        pattern: String.raw`PN-\d{4}`,
      }),
    ).toMatchObject({ examples: [], counterExamples: [] });
    expect(() => customEntityTypeFromJSON({ name: 'PET_NAME', description: 'x', examples: [] })).toThrow(
      new LearningError('At least one example is needed.'),
    );
  });

  it('leaves defineCustomEntityType() strict, as in PHP', () => {
    expect(() => defineCustomEntityType({ ...POLICY, examples: [], pattern: String.raw`PN-\d{4}` })).toThrow(
      new LearningError('At least one example is needed.'),
    );
  });

  it('reaches the model with name and description only', () => {
    const type = withoutExamples(defineCustomEntityType({ ...POLICY, pattern: String.raw`PN-\d{4}-\d{6}` }));

    expect(instructions([type])).toContain('"examples":[],"notThisType":[]');
  });
});

describe('EntityLearner keepExamples: false', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pii-shield-privacy-'));
    file = join(dir, 'learned.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores only name, description and pattern, and still detects the type', async () => {
    const learner = await EntityLearner.create({ store: new JsonFileCustomEntityStore(file), keepExamples: false });
    const { type } = await learner.learn(POLICY);

    expect(learner.keepExamples).toBe(false);
    expect(type).toMatchObject({ examples: [], counterExamples: [], pattern: String.raw`PN-\d{4}-\d{6}` });
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toMatch(/000417|998812|PN-12"/);
    expect(JSON.parse(raw)).toEqual([JSON.parse(JSON.stringify(type))]);

    const reloaded = await EntityLearner.create({ store: new JsonFileCustomEntityStore(file) });
    expect(new PiiShield({ learner: reloaded }).redact(TEXT).redactedText).toBe(
      'Polizze ⟦POLICY_NUMBER_1⟧, Kontakt ⟦EMAIL_1⟧',
    );
  });

  it('checks the pattern against the examples before dropping them', async () => {
    const learner = new EntityLearner({ store: new InMemoryCustomEntityStore(), keepExamples: false });

    await expect(learner.learn({ ...POLICY, counterExamples: ['PN-2026-999999'] })).rejects.toThrow(LearningError);
    await expect(learner.learn({ ...POLICY, pattern: String.raw`XX-\d{4}` })).rejects.toThrow(
      new LearningError(String.raw`The pattern XX-\d{4} does not match example 1.`),
    );
  });

  it('previews what it would store', () => {
    const learner = new EntityLearner({ store: new InMemoryCustomEntityStore(), keepExamples: false });

    expect(learner.preview(POLICY).type.examples).toEqual([]);
  });

  it('refuses model-only types instead of storing a type nothing can find', async () => {
    const store = new InMemoryCustomEntityStore();
    const learner = new EntityLearner({ store, keepExamples: false });

    const error = await learner.learn(PET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LearningError);
    expect((error as Error).message).not.toMatch(/Bello|Minka/);
    expect(await store.all()).toEqual([]);
    // A hand-written pattern makes it learnable.
    expect((await learner.learn({ ...PET, pattern: '(?:Bello|Minka)' })).type.examples).toEqual([]);
  });

  it.each([
    ['json file', (f: string) => new JsonFileCustomEntityStore(f)],
    [
      'key-value',
      () => {
        const map = new Map<string, string>();

        return new KeyValueCustomEntityStore({
          get: (key) => Promise.resolve(map.get(key)),
          set: (key, value) => Promise.resolve(map.set(key, value)),
        });
      },
    ],
  ])('%s: loads types without examples next to types with them', async (_, make) => {
    const store = make(file);
    await new EntityLearner({ store }).learn(PET);
    await new EntityLearner({ store, keepExamples: false }).learn(POLICY);

    expect((await store.all()).map((t) => [t.name, t.examples.length])).toEqual([
      ['PET_NAME', 2],
      ['POLICY_NUMBER', 0],
    ]);
  });
});

describe('EntityLearner.dropExamples()', () => {
  it('strips types with a pattern, keeps model-only types, and is idempotent', async () => {
    const store = new InMemoryCustomEntityStore();
    const learner = new EntityLearner({ store });
    await learner.learn(POLICY);
    await learner.learn(PET);

    expect(await learner.dropExamples()).toEqual({ stripped: ['POLICY_NUMBER'], kept: ['PET_NAME'] });
    expect((await store.get('POLICY_NUMBER'))?.examples).toEqual([]);
    expect((await store.get('PET_NAME'))?.examples).toEqual(PET.examples);
    expect(learner.snapshot.find((t) => t.name === 'POLICY_NUMBER')?.examples).toEqual([]);
    expect(new PiiShield({ learner }).redact(TEXT).redactedText).toContain('⟦POLICY_NUMBER_1⟧');

    expect(await learner.dropExamples()).toEqual({ stripped: [], kept: ['PET_NAME'] });
  });
});

describe('the learner option of PiiShield, PiiMasker and EntityExtractor', () => {
  it('adds the learned types to the default detectors', async () => {
    const learner = new EntityLearner({ store: new InMemoryCustomEntityStore() });
    const shield = new PiiShield({ learner });
    const masker = new PiiMasker({ learner });

    expect(shield.redact(TEXT).redactedText).toBe('Polizze PN-2026-123456, Kontakt ⟦EMAIL_1⟧');
    await learner.learn(POLICY);
    expect(shield.redact(TEXT).redactedText).toBe('Polizze ⟦POLICY_NUMBER_1⟧, Kontakt ⟦EMAIL_1⟧');
    expect(masker.mask(TEXT)).toBe('Polizze [POLICY_NUMBER], Kontakt [EMAIL]');
  });

  it('adds them to the given detectors', async () => {
    const learner = new EntityLearner({ store: new InMemoryCustomEntityStore() });
    await learner.learn(POLICY);

    expect(new PiiShield({ detectors: [], learner }).redact(TEXT).redactedText).toBe(
      'Polizze ⟦POLICY_NUMBER_1⟧, Kontakt max@example.com',
    );
  });

  it('does not register the learner twice', async () => {
    const learner = new EntityLearner({ store: new InMemoryCustomEntityStore() });
    await learner.learn(POLICY);
    expect(learner.detector()).toBe(learner.detector());
    const detect = vi.spyOn(learner.detector(), 'detect');

    new EntityExtractor({ detectors: [...defaultDetectors(), learner.detector()], learner }).extract(TEXT);
    expect(detect).toHaveBeenCalledTimes(1);
  });
});

describe('service: PII_SERVICE_LEARNED_KEEP_EXAMPLES', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pii-shield-privacy-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores learned types without examples and refuses model-only types', async () => {
    const service = await serviceFromEnv({ PII_SERVICE_LEARNED_KEEP_EXAMPLES: 'false' });

    const learned = await service.api.operation('learn', POLICY);
    expect(learned.status).toBe(201);
    expect(learned.body).toMatchObject({ type: { examples: [], counterExamples: [] }, saved: true });
    expect((await service.api.operation('entities', {})).body).toMatchObject({
      types: [{ name: 'POLICY_NUMBER', examples: [] }],
    });
    expect((await service.api.operation('learn', PET)).status).toBe(422);
  });

  it('notes types that still hold examples', async () => {
    const file = join(dir, 'learned.json');
    await writeFile(
      file,
      `${JSON.stringify([defineCustomEntityType({ ...POLICY, pattern: String.raw`PN-\d{4}-\d{6}` })])}\n`,
    );
    const service = await serviceFromEnv({
      PII_SERVICE_LEARNED_TYPES: file,
      PII_SERVICE_LEARNED_KEEP_EXAMPLES: 'false',
    });

    expect(service.notes.some((n) => n.includes('dropExamples()'))).toBe(true);
  });

  it('rejects other values', async () => {
    await expect(serviceFromEnv({ PII_SERVICE_LEARNED_KEEP_EXAMPLES: 'no' })).rejects.toThrow(
      'PII_SERVICE_LEARNED_KEEP_EXAMPLES must be "true" or "false".',
    );
  });
});
