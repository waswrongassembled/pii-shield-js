import { describe, expect, it } from 'vitest';

import {
  DetectionError,
  EntityLearner,
  InMemoryCustomEntityStore,
  ModelDetector,
  ModelLocation,
  PiiShieldError,
} from '../src/index.js';
import type { ServiceResponse } from '../src/server/index.js';
import { fakeModelDetector, serviceApi, TOKEN } from './support/service.js';

const LETTER = 'Herrn\nJohann Beispielmann\n\nSVNR 4568 150392, Versicherung VN-2026-000417';

/** Port of PHP's tests/Demo/ServiceApiTest. */
describe('ServiceApi', () => {
  const api = serviceApi({ modelDetector: fakeModelDetector() });
  const call = (
    method: string,
    path: string,
    body: Record<string, unknown> | null = null,
    token: string | null = TOKEN,
    remoteAddress = '10.0.0.5',
  ): Promise<ServiceResponse> =>
    api.handle({ method, path, body, authorization: token === null ? undefined : `Bearer ${token}`, remoteAddress });

  it('redact returns placeholders but never the originals', async () => {
    const response = await call('POST', '/v1/redact', { text: LETTER });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      text: 'Herrn\n⟦PERSON_1⟧\n\nSVNR ⟦SVNR_1⟧, Versicherung VN-2026-000417',
      expiresIn: 900,
      placeholders: [
        { placeholder: '⟦PERSON_1⟧', type: 'PERSON' },
        { placeholder: '⟦SVNR_1⟧', type: 'SVNR' },
      ],
    });
    expect(response.body?.['vaultId']).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(response.body)).not.toContain('Beispielmann');
  });

  it('restores and forgets', async () => {
    const vaultId = (await call('POST', '/v1/redact', { text: LETTER })).body?.['vaultId'];

    const restored = await call('POST', '/v1/restore', { text: 'Hallo ⟦PERSON_1⟧, ⟦IBAN_9⟧?', vaultId });
    expect(restored).toEqual({
      status: 200,
      body: {
        text: 'Hallo Johann Beispielmann, ⟦IBAN_9⟧?',
        unknownPlaceholders: ['⟦IBAN_9⟧'],
        unusedPlaceholders: ['⟦SVNR_1⟧'],
      },
    });

    expect((await call('DELETE', `/v1/vault/${String(vaultId)}`)).status).toBe(204);
    expect(await call('POST', '/v1/restore', { text: '⟦PERSON_1⟧', vaultId })).toEqual({
      status: 404,
      body: { error: 'Unknown or expired vault id. Redact the text again.' },
    });
  });

  it('masks', async () => {
    const response = await call('POST', '/v1/mask', { text: 'IBAN AT61 1904 3002 3457 3201, SVNR 4568 150392' });

    expect(response.body).toEqual({ text: 'IBAN AT61 **** **** **** 3201, SVNR [SVNR]' });
  });

  it('uses learned types for redact', async () => {
    const api = serviceApi();
    const call = (method: string, path: string, body: Record<string, unknown> | null = null) =>
      api.handle({ method, path, body, authorization: `Bearer ${TOKEN}` });
    const learned = await call('POST', '/v1/learn', {
      name: 'INSURANCE_NUMBER',
      description: 'Versichertennummer',
      examples: ['VN-2026-000417', 'VN-2025-998812'],
    });

    expect(learned.status).toBe(201);
    expect(learned.body).toEqual({
      type: {
        name: 'INSURANCE_NUMBER',
        description: 'Versichertennummer',
        examples: ['VN-2026-000417', 'VN-2025-998812'],
        counterExamples: [],
        pattern: String.raw`VN-\d{4}-\d{6}`,
      },
      note: null,
      saved: true,
    });

    const redacted = await call('POST', '/v1/redact', { text: LETTER });
    expect(redacted.body?.['text']).toMatch(/Versicherung ⟦INSURANCE_NUMBER_1⟧$/);

    const types = (await call('GET', '/v1/entities')).body?.['types'] as { name: string }[];
    expect(types.map((t) => t.name)).toEqual(['INSURANCE_NUMBER']);
    expect((await call('DELETE', '/v1/entities/INSURANCE_NUMBER')).status).toBe(204);
    expect((await call('GET', '/v1/entities')).body).toEqual({ types: [] });
    expect(await call('DELETE', '/v1/entities/INSURANCE_NUMBER')).toEqual({
      status: 404,
      body: { error: 'No learned type "INSURANCE_NUMBER".' },
    });
  });

  it('does not save on a dry run', async () => {
    const api = serviceApi();
    const response = await api.operation('learn', {
      name: 'INSURANCE_NUMBER',
      examples: ['VN-2026-000417'],
      dryRun: true,
    });

    expect(response.status).toBe(200);
    expect(response.body?.['saved']).toBe(false);
    expect((await api.operation('entities', {})).body).toEqual({ types: [] });
  });

  it('learns plain words as model-only types', async () => {
    const response = await serviceApi().operation('learn', {
      name: 'PET_NAME',
      examples: ['Bello', 'Rex'],
      dryRun: true,
    });

    expect(response.body).toMatchObject({
      type: { name: 'PET_NAME', pattern: null },
      note: 'No pattern: plain words would match ordinary text. Only model-based detection finds this type.',
    });
  });

  it('answers learning errors with 422', async () => {
    const response = await call('POST', '/v1/learn', { name: 'IBAN', examples: ['VN-2026-000417'] });

    expect(response).toEqual({ status: 422, body: { error: '"IBAN" is a built-in type. Choose another name.' } });
  });

  it('uses model detection when requested', async () => {
    const response = await call('POST', '/v1/redact', { text: 'Johann Beispielmann zahlt.', detection: 'model' });

    expect(response.body?.['text']).toBe('⟦PERSON_1⟧ zahlt.');
  });

  it('does not leak model error details', async () => {
    const errors: unknown[] = [];
    const api = serviceApi({
      modelDetector: () =>
        new ModelDetector({
          model: {
            name: 'secret-model-name',
            generate: () => Promise.resolve('not json, internal detail: http://10.0.0.7:11434'),
          },
          location: ModelLocation.Local,
        }),
      onError: (e) => errors.push(e),
    });

    const response = await api.handle({
      method: 'POST',
      path: '/v1/redact',
      body: { text: 'x', detection: 'model' },
      authorization: `Bearer ${TOKEN}`,
    });

    expect(response).toEqual({ status: 502, body: { error: 'Model-based detection failed.' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DetectionError);
  });

  it('answers 422 for model detection without a configured model', async () => {
    expect(await serviceApi().operation('mask', { text: 'x', detection: 'both' })).toEqual({
      status: 422,
      body: { error: 'Model-based detection is not configured on this server.' },
    });
  });

  it('answers other library errors with a generic 500', async () => {
    const api = serviceApi({
      modelDetector: () => ({
        async: true,
        detect: () =>
          Promise.reject(new PiiShieldError('Regex failed: Backtrack limit exhausted', 'DETECTION_BACKTRACK_LIMIT')),
      }),
    });

    expect(await api.operation('redact', { text: 'x', detection: 'model' })).toEqual({
      status: 500,
      body: { error: 'Detection failed.' },
    });
  });

  it('requires the token', async () => {
    expect((await call('POST', '/v1/mask', { text: 'x' }, null)).status).toBe(401);
    expect(await call('POST', '/v1/mask', { text: 'x' }, 'wrong')).toEqual({
      status: 401,
      body: { error: 'Missing or invalid bearer token.' },
    });
    expect((await call('POST', '/v1/mask', { text: 'x' }, null, '127.0.0.1')).status).toBe(401);
  });

  it('allows only local peers without a configured token', async () => {
    const api = serviceApi({ token: undefined });

    expect(
      (await api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' }, remoteAddress: '127.0.0.1' })).status,
    ).toBe(200);
    expect(
      (await api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' }, remoteAddress: '::1' })).status,
    ).toBe(200);
    expect(
      (await api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' }, remoteAddress: '10.0.0.5' })).status,
    ).toBe(401);
    expect((await api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' } })).status).toBe(401);
  });

  it('treats an empty token as none', async () => {
    const api = serviceApi({ token: '' });

    expect(
      (await api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' }, authorization: 'Bearer ' })).status,
    ).toBe(401);
  });

  it('refuses to run without a token in service mode', async () => {
    const api = serviceApi({ token: undefined, requireToken: true });

    expect(
      await api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' }, remoteAddress: '127.0.0.1' }),
    ).toEqual({
      status: 503,
      body: { error: 'Set PII_SERVICE_TOKEN to use this service.' },
    });
  });

  it('answers health without a token and reveals nothing', async () => {
    expect(await call('GET', '/v1/health', null, null)).toEqual({
      status: 200,
      body: { status: 'ok', modelDetection: true },
    });
    expect((await serviceApi().handle({ method: 'GET', path: '/v1/health', body: null })).body).toEqual({
      status: 'ok',
      modelDetection: false,
    });
    expect(await call('POST', '/v1/health', {}, null)).toEqual({ status: 405, body: { error: 'Use GET.' } });
  });

  it('answers unknown routes and methods', async () => {
    expect(await call('GET', '/v1/nope')).toEqual({ status: 404, body: { error: 'Not found.' } });
    expect(await call('GET', '/v1/redact')).toEqual({ status: 405, body: { error: 'Use POST.' } });
    expect(await call('POST', '/v1/entities')).toEqual({ status: 405, body: { error: 'Use GET.' } });
    expect(await call('GET', '/v1/entities/FOO')).toEqual({ status: 405, body: { error: 'Use DELETE.' } });
    expect(await call('GET', `/v1/vault/${'a'.repeat(32)}`)).toEqual({ status: 405, body: { error: 'Use DELETE.' } });
    expect((await call('DELETE', '/v1/entities/lower')).status).toBe(404);
    expect((await call('DELETE', `/v1/vault/${'A'.repeat(32)}`)).status).toBe(404);
    expect((await call('GET', '/v1/constructor')).status).toBe(404);
    expect((await call('POST', '/v1/redact', { text: 42 })).status).toBe(400);
  });

  it.each([
    [{}, '"text" must be a string.'],
    [{ text: null }, '"text" must be a string.'],
    [{ text: ['x'] }, '"text" must be a string.'],
    [{ text: 'x'.repeat(100_001) }, '"text" is longer than 100000 characters.'],
    [{ text: 'x', detection: 'fast' }, '"detection" must be "regex", "model" or "both".'],
    [{ text: 42, detection: 'fast' }, '"detection" must be "regex", "model" or "both".'],
    [{ text: 'x', types: ['SVNR', 'NAME'] }, 'Unknown type "NAME".'],
    [{ text: 'x', types: 'SVNR' }, '"types" must be a list of strings.'],
    [{ text: 'x', allowlist: [1] }, '"allowlist" must be a list of strings.'],
    [{ text: 42, allowlist: [1] }, '"allowlist" must be a list of strings.'],
  ])('rejects %j', async (body, message) => {
    expect(await api.operation('redact', body)).toEqual({ status: 400, body: { error: message } });
  });

  it('counts the text length in code points', async () => {
    expect((await api.operation('mask', { text: '😀'.repeat(100_000) })).status).toBe(200);
  });

  it('accepts null as a missing field and a JSON object as a list (PHP arrays)', async () => {
    const response = await api.operation('mask', {
      text: 'SVNR 4568 150392',
      detection: null,
      types: null,
      allowlist: { a: '4568 150392' },
    });

    expect(response.body).toEqual({ text: 'SVNR 4568 150392' });
  });

  it('keeps only the requested types; learned types only with OTHER (as PHP)', async () => {
    const api = serviceApi();
    await api.operation('learn', { name: 'INSURANCE_NUMBER', examples: ['VN-2026-000417', 'VN-2025-998812'] });

    expect((await api.operation('mask', { text: LETTER, types: ['SVNR'] })).body).toEqual({
      text: 'Herrn\nJohann Beispielmann\n\nSVNR [SVNR], Versicherung VN-2026-000417',
    });
    expect((await api.operation('mask', { text: LETTER, types: ['SVNR', 'OTHER'] })).body).toEqual({
      text: 'Herrn\nJohann Beispielmann\n\nSVNR [SVNR], Versicherung [INSURANCE_NUMBER]',
    });
  });

  it('keeps authority contacts unless told otherwise', async () => {
    const text = 'Bitte kontaktieren Sie uns unter post@bh.example.';

    expect((await api.operation('mask', { text })).body?.['text']).toContain('post@bh.example');
    expect((await api.operation('mask', { text, keepAuthorityContacts: false })).body?.['text']).not.toContain(
      'post@bh.example',
    );
  });

  it('applies the allowlist', async () => {
    expect(
      (await api.operation('redact', { text: 'SVNR 4568 150392', allowlist: ['4568 150392'] })).body,
    ).toMatchObject({
      text: 'SVNR 4568 150392',
      placeholders: [],
    });
  });

  it('picks up types another process learned', async () => {
    const store = new InMemoryCustomEntityStore();
    const api = serviceApi({ learner: await EntityLearner.create({ store }) });
    await new EntityLearner({ store }).learn({
      name: 'POLICY_NUMBER',
      description: '',
      examples: ['POL-2026-004711', 'POL-2025-000815'],
    });

    expect((await api.operation('mask', { text: 'Polizze POL-2026-123456' })).body).toEqual({
      text: 'Polizze [POLICY_NUMBER]',
    });
  });

  it('rejects a non-positive vault TTL', () => {
    expect(() => serviceApi({ vaultTtl: 0 })).toThrow(RangeError);
  });
});
