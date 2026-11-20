import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { type PiiShieldServer, startServer } from '../src/server/index.js';
import { fakeModelDetector, serviceApi, TOKEN } from './support/service.js';

/**
 * Keeps docs/openapi.yaml and the service in sync (port of PHP's OpenApiContractTest): every documented
 * operation is callable with its example and answers with a documented status, every route is
 * documented, and every response body matches the documented schema.
 */
interface Operation {
  requestBody?: { content: { 'application/json': { example?: unknown } } };
  responses: Record<string, { $ref?: string; content?: Record<string, { schema?: unknown; example?: unknown }> }>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components: { responses: Record<string, Operation['responses'][string]> };
}

const SPEC_TEXT = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
const spec = parse(SPEC_TEXT) as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(spec, 'openapi');

const pointer = (...parts: string[]) => parts.map((p) => p.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');

/** The JSON schema pointer of a documented response, or null when the status is not documented. */
function responseSchema(path: string, method: string, status: number): string | null {
  const response = spec.paths[path]?.[method]?.responses[String(status)];
  if (response === undefined) {
    return null;
  }
  if (response.$ref !== undefined) {
    const name = response.$ref.replace('#/components/responses/', '');

    return `openapi#/${pointer('components', 'responses', name, 'content', 'application/json', 'schema')}`;
  }
  if (response.content?.['application/json']?.schema === undefined) {
    return '';
  }

  return `openapi#/${pointer('paths', path, method, 'responses', String(status), 'content', 'application/json', 'schema')}`;
}

function expectDocumented(path: string, method: string, status: number, body: unknown): void {
  const schema = responseSchema(path, method, status);
  expect(schema, `${method.toUpperCase()} ${path} answered an undocumented ${String(status)}`).not.toBeNull();
  if (schema === '' || schema === null) {
    expect(body).toBeNull();

    return;
  }
  const validate = ajv.compile({ $ref: schema });
  expect(validate(body), `${method.toUpperCase()} ${path} ${String(status)}: ${ajv.errorsText(validate.errors)}`).toBe(
    true,
  );
}

let server: PiiShieldServer;

beforeAll(async () => {
  const api = serviceApi({ modelDetector: fakeModelDetector() });
  await api.operation('learn', {
    name: 'INSURANCE_NUMBER',
    description: 'Polizzennummer',
    examples: ['VN-2026-000417', 'VN-2025-998812'],
  });
  server = await startServer({ api, port: 0 });
});
afterAll(() => server.close());

async function request(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(server.url + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();

  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown), response };
}

const concrete = (path: string) => path.replace('{vaultId}', 'a'.repeat(32)).replace('{name}', 'INSURANCE_NUMBER');

const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.entries(methods)
    .filter(() => path !== '/v1/openapi.yaml')
    .map(([method, operation]) => [`${method.toUpperCase()} ${path}`, path, method, operation] as const),
);

describe('docs/openapi.yaml', () => {
  it.each(operations)(
    '%s answers its example with a documented status and schema',
    async (_, path, method, operation) => {
      const example = operation.requestBody?.content['application/json'].example;
      const { status, body } = await request(method.toUpperCase(), concrete(path), example);

      expectDocumented(path, method, status, body);
    },
  );

  it('catches bodies that do not match', () => {
    expect(() => {
      expectDocumented('/v1/redact', 'post', 200, { text: 'x', vaultId: 'nope', expiresIn: 900, placeholders: [] });
    }).toThrow();
    expect(() => {
      expectDocumented('/v1/redact', 'post', 400, { message: 'x' });
    }).toThrow();
    expect(() => {
      expectDocumented('/v1/redact', 'post', 405, { error: 'x' });
    }).toThrow();
  });

  it('documents every route', () => {
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
    );

    expect(documented.sort()).toEqual(
      [
        'POST /v1/redact',
        'POST /v1/restore',
        'DELETE /v1/vault/{vaultId}',
        'POST /v1/mask',
        'POST /v1/learn',
        'GET /v1/entities',
        'DELETE /v1/entities/{name}',
        'GET /v1/health',
        'GET /v1/openapi.yaml',
      ].sort(),
    );
  });

  it('gives the documented redact example', async () => {
    // Learned again: the DELETE /v1/entities/{name} example forgets it.
    await request('POST', '/v1/learn', { name: 'INSURANCE_NUMBER', examples: ['VN-2026-000417', 'VN-2025-998812'] });
    const operation = spec.paths['/v1/redact']?.['post'];
    const example = operation?.requestBody?.content['application/json'].example;
    const documented = operation?.responses['200']?.content?.['application/json']?.example as Record<string, unknown>;
    const { body } = await request('POST', '/v1/redact', example);

    expect(body).toMatchObject({ text: documented['text'], placeholders: documented['placeholders'], expiresIn: 900 });
  });

  it('serves itself', async () => {
    const response = await fetch(`${server.url}/v1/openapi.yaml`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/yaml; charset=utf-8');
    expect(await response.text()).toBe(SPEC_TEXT);
  });

  it.each<[string, string, string, unknown, (string | null)?]>([
    ['redact, model', 'post', '/v1/redact', { text: 'Johann Beispielmann zahlt.', detection: 'both' }],
    ['redact, invalid', 'post', '/v1/redact', { text: 42 }],
    ['redact, unauthorized', 'post', '/v1/redact', { text: 'x' }, null],
    ['mask, model', 'post', '/v1/mask', { text: 'Johann Beispielmann zahlt.', detection: 'model' }],
    ['mask, invalid', 'post', '/v1/mask', { text: 'x', types: ['NOPE'] }],
    ['restore, unknown vault', 'post', '/v1/restore', { text: 'x', vaultId: '0'.repeat(32) }],
    ['restore, invalid', 'post', '/v1/restore', { vaultId: '0'.repeat(32) }],
    ['learn, dry run', 'post', '/v1/learn', { name: 'POLICY_NUMBER', examples: ['POL-2026-004711'], dryRun: true }],
    ['learn, model-only', 'post', '/v1/learn', { name: 'PET_NAME', examples: ['Bello'], dryRun: true }],
    ['learn, invalid', 'post', '/v1/learn', { name: 'x', examples: ['POL-2026-004711'] }],
    ['learn, not a list', 'post', '/v1/learn', { name: 'POLICY_NUMBER', examples: 'POL-2026-004711' }],
    ['entities, unauthorized', 'get', '/v1/entities', undefined, 'wrong'],
    ['forget, unknown', 'delete', '/v1/entities/NOT_LEARNED', undefined],
    ['forget vault', 'delete', `/v1/vault/${'b'.repeat(32)}`, undefined],
  ])('%s matches the documented response', async (_, method, path, body, token = TOKEN) => {
    const result = await request(method.toUpperCase(), path, body, token);
    const documentedPath = path
      .replace(/[0-9a-f]{32}$/, '{vaultId}')
      .replace(/\/entities\/[A-Z_]+$/, '/entities/{name}');

    expectDocumented(documentedPath, method, result.status, result.body);
  });

  it('documents a restore of a real redaction', async () => {
    const redacted = await request('POST', '/v1/redact', { text: 'SVNR 4568 150392' });
    const vaultId = (redacted.body as { vaultId: string }).vaultId;
    const restored = await request('POST', '/v1/restore', { text: '⟦SVNR_1⟧ ⟦IBAN_9⟧', vaultId });

    expectDocumented('/v1/restore', 'post', restored.status, restored.body);
    expect(restored.body).toEqual({
      text: '4568 150392 ⟦IBAN_9⟧',
      unknownPlaceholders: ['⟦IBAN_9⟧'],
      unusedPlaceholders: [],
    });
  });
});
