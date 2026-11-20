import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  customEntityTypeFromJSON,
  CustomEntityDetector,
  defaultDetectors,
  defineCustomEntityType,
  EntityLearner,
  JsonFileCustomEntityStore,
  LearningError,
  learnPattern,
  patternViolation,
  PiiMasker,
  PiiShield,
} from '../src/index.js';
import { LearnedPattern } from '../src/learning/learned-pattern.js';
import { expectedEntity, type FixtureError, loadFixture } from './support/fixtures.js';

const fixture = loadFixture('learning');

/** The TypeScript error for a PHP exception: LearningError with the same message, PHP code 1 = plain words. */
function expectLearningError(fn: () => unknown, error: FixtureError): void {
  expect(error.class).toBe('LearningFailedException');
  expect(fn).toThrow(LearningError);
  expect(fn).toThrow(error.message);
  try {
    fn();
  } catch (e) {
    expect((e as LearningError).message).toBe(error.message);
    expect((e as LearningError).code).toBe(error.code === 1 ? 'LEARNING_PLAIN_WORDS' : 'LEARNING_FAILED');
  }
}

describe('PHP parity (fixtures/learning.json)', () => {
  it.each(fixture.patternLearner)('pattern learner: $case', (c) => {
    if (c.error !== undefined) {
      expectLearningError(() => learnPattern(c.examples, c.counterExamples), c.error);
    } else {
      expect(learnPattern(c.examples, c.counterExamples)).toBe(c.result);
    }
  });

  it.each(fixture.customEntityType)('custom entity type: $case', (c) => {
    if (c.error !== undefined) {
      expectLearningError(() => defineCustomEntityType(c.input), c.error);
    } else {
      expect(JSON.parse(JSON.stringify(defineCustomEntityType(c.input)))).toStrictEqual(c.result);
    }
  });

  it.each(fixture.fromArray)('fromArray: $case', (c) => {
    if (c.error !== undefined) {
      expectLearningError(() => customEntityTypeFromJSON(c.input), c.error);
    } else {
      expect(JSON.stringify(customEntityTypeFromJSON(c.input))).toBe(JSON.stringify(c.result));
    }
  });

  const grammarCases = (section: typeof fixture.grammar) =>
    section.cases.map((c) => ({ ...c, probes: section.probes, name: JSON.stringify(c.pattern).slice(0, 60) }));

  it.each([...grammarCases(fixture.grammar), ...grammarCases(fixture.grammarExtra)])('grammar: $name', (c) => {
    expect(patternViolation(c.pattern)).toBe(c.violation);
    const compiled = LearnedPattern.compile(c.pattern);
    const compiles = compiled instanceof LearnedPattern || compiled.compiles;
    expect(compiles).toBe(c.compiles);
    if (c.fullMatches !== null) {
      expect(compiled).toBeInstanceOf(LearnedPattern);
      const pattern = compiled as LearnedPattern;
      expect(c.probes.filter((probe) => pattern.matchesWhole(probe))).toStrictEqual(c.fullMatches);
    }
  });

  it.each(fixture.search.map((c) => ({ ...c, name: c.pattern })))('search: $name', (c) => {
    const detect = () =>
      new CustomEntityDetector(
        defineCustomEntityType({ name: 'SOME_NUMBER', description: 'x', examples: [c.example], pattern: c.pattern }),
      ).detect(c.text);
    expect(c.error).toBeUndefined();
    expect(detect()).toStrictEqual((c.result ?? []).map((e) => expectedEntity(c.text, e)));
  });

  it.each(fixture.budget.map((c) => ({ ...c, name: c.pattern.slice(0, 50) })))('time budget: $name', (c) => {
    const define = () =>
      defineCustomEntityType({ name: 'SOME_NUMBER', description: 'x', examples: [c.example], pattern: c.pattern });
    if (c.error !== undefined) {
      expectLearningError(define, c.error);
    } else {
      expect(define().pattern).toBe(c.result);
    }
  });

  it.each(fixture.learnerEscapes.map((c) => ({ ...c, name: c.examples.join() })))('learner escapes: $name', (c) => {
    const learner = new EntityLearner({ store: new JsonFileCustomEntityStore('/nonexistent/x.json') });
    const preview = () => learner.preview({ name: 'SOME_NUMBER', description: 'x', examples: c.examples }).type.pattern;
    if (c.error !== undefined) {
      expectLearningError(preview, c.error);
    } else {
      expect(preview()).toBe(c.result);
    }
  });

  it.each(fixture.preview)('preview: $case', (c) => {
    const learner = new EntityLearner({ store: new JsonFileCustomEntityStore('/nonexistent/x.json') });
    if (c.error !== undefined) {
      expectLearningError(() => learner.preview(c.input), c.error);
    } else {
      const result = learner.preview(c.input);
      expect(JSON.parse(JSON.stringify(result))).toStrictEqual(c.result);
    }
  });

  describe('JSON file store', () => {
    const dirs: string[] = [];
    afterAll(async () => {
      await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
    });

    it('writes the same file as PHP, also after forget, and detects the same entities', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pii-shield-learning-'));
      dirs.push(dir);
      const file = join(dir, 'learned.json');
      const learner = await EntityLearner.create({ store: new JsonFileCustomEntityStore(file) });
      for (const {
        learn: [name, description, examples, counterExamples, pattern],
      } of fixture.jsonStore.steps) {
        await learner.learn({ name, description, examples, counterExamples, pattern });
      }
      expect(await readFile(file, 'utf8')).toBe(fixture.jsonStore.file);

      await learner.forget(fixture.jsonStore.afterForget.forget);
      expect(await readFile(file, 'utf8')).toBe(fixture.jsonStore.afterForget.file);

      const { text, entities } = fixture.jsonStore.detect;
      expect(learner.detector().detect(text)).toStrictEqual(entities.map((e) => expectedEntity(text, e)));
    });

    it('reads the file PHP wrote', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pii-shield-learning-'));
      dirs.push(dir);
      const file = join(dir, 'learned.json');
      await import('node:fs/promises').then((fs) => fs.writeFile(file, fixture.jsonStore.file));
      const types = await new JsonFileCustomEntityStore(file).all();
      expect(types.map((t) => t.name)).toStrictEqual(['AKTEN_ZAHL', 'INSURANCE_NUMBER', 'PET_NAME']);
    });
  });
});

describe('PHP parity (fixtures/redaction.json, custom types)', () => {
  it.each(loadFixture('redaction').configured.filter((c) => c.customTypes.length > 0))('configured: $case', (c) => {
    const detectors = [
      ...defaultDetectors(),
      ...c.customTypes.map((t) => new CustomEntityDetector(customEntityTypeFromJSON(t))),
    ];
    const result = new PiiShield({ detectors, allowlist: c.allowlist }).redact(c.text);

    expect(result.redactedText).toBe(c.redaction.redactedText);
    expect(Object.entries(result.mapping)).toEqual(Object.entries(c.redaction.vault));
    expect(result.entities).toEqual(c.redaction.entities.map((e) => expectedEntity(c.text, e)));
    expect(new PiiMasker({ detectors, allowlist: c.allowlist }).mask(c.text)).toBe(c.mask);
  });
});
