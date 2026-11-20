import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../src/cli.js';
import { generateVaultKey, ModelLocation, type ModelPrompt } from '../src/index.js';
import { ConfigError, serviceFromEnv } from '../src/server/config.js';
import { providerModel, validEndpoint } from '../src/server/model-providers.js';
import { postJson, rawRequest } from './support/http.js';

const KEY = Buffer.from(generateVaultKey()).toString('base64');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serviceFromEnv', () => {
  it('defaults to in-memory stores on 127.0.0.1:8088 without a model', async () => {
    const service = await serviceFromEnv({});

    expect(service).toMatchObject({ host: '127.0.0.1', port: 8088, allowedHosts: [], maxBodyBytes: 2 * 1024 * 1024 });
    expect(service.api.modelDetection).toBe(false);
    expect(service.notes).toHaveLength(2);
    expect(
      (await service.api.handle({ method: 'POST', path: '/v1/mask', body: { text: 'x' }, remoteAddress: '10.0.0.1' }))
        .status,
    ).toBe(401);
  });

  it('reads token, service mode, hosts, local peers and limits', async () => {
    const service = await serviceFromEnv({
      PII_SERVICE_TOKEN: 'secret',
      PII_SERVICE_ONLY: '1',
      PII_SERVICE_ALLOWED_HOSTS: 'pii.example, other.example ,',
      PII_SERVICE_HOST: '0.0.0.0',
      PII_SERVICE_PORT: '9000',
      PII_SERVICE_MAX_BODY_BYTES: '4096',
      PII_SERVICE_VAULT_TTL: '60',
      PII_SERVICE_VAULT_KEY: KEY,
    });

    expect(service).toMatchObject({
      host: '0.0.0.0',
      port: 9000,
      allowedHosts: ['pii.example', 'other.example'],
      maxBodyBytes: 4096,
    });
    expect((await service.api.operation('redact', { text: 'x' })).body).toMatchObject({ expiresIn: 60 });
    expect(service.api.checkAccess('Bearer secret', undefined)).toBeNull();
    expect(service.api.checkAccess(undefined, '127.0.0.1')?.status).toBe(401);

    const local = await serviceFromEnv({ PII_LOCAL_PEERS: '172.31.88.1' });
    expect(local.api.checkAccess(undefined, '172.31.88.1')).toBeNull();
    expect(local.api.checkAccess(undefined, '172.31.88.7')?.status).toBe(401);
  });

  it('keeps learned types in a JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pii-shield-cli-'));
    try {
      const file = join(dir, 'learned-types.json');
      const service = await serviceFromEnv({ PII_SERVICE_LEARNED_TYPES: file });
      await service.api.operation('learn', { name: 'POLICY_NUMBER', examples: ['POL-2026-004711', 'POL-2025-000815'] });

      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([expect.objectContaining({ name: 'POLICY_NUMBER' })]);
      const again = await serviceFromEnv({ PII_SERVICE_LEARNED_TYPES: file });
      expect((await again.api.operation('mask', { text: 'POL-2026-123456' })).body).toEqual({
        text: '[POLICY_NUMBER]',
      });
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it.each([
    [{ PII_SERVICE_VAULT_KEY: 'too short' }, 'PII_SERVICE_VAULT_KEY must be 32 bytes, base64-encoded.'],
    [{ PII_SERVICE_VAULT_STORE: 'filesystem' }, 'PII_SERVICE_VAULT_STORE must be "memory" or "redis".'],
    [
      { PII_SERVICE_VAULT_STORE: 'redis' },
      'The redis vault store needs PII_SERVICE_VAULT_KEY, or mappings cannot be read after a restart.',
    ],
    [
      { PII_SERVICE_VAULT_STORE: 'redis', PII_SERVICE_VAULT_KEY: KEY },
      'Set PII_SERVICE_REDIS_URL to use the redis store.',
    ],
    [{ PII_SERVICE_LEARNED_STORE: 'file' }, 'Set PII_SERVICE_LEARNED_TYPES to the JSON file of learned types.'],
    [{ PII_SERVICE_LEARNED_STORE: 'sqlite' }, 'PII_SERVICE_LEARNED_STORE must be "file", "memory" or "redis".'],
    [{ PII_SERVICE_PORT: '80a' }, 'PII_SERVICE_PORT must be an integer of at least 0.'],
    [{ PII_SERVICE_VAULT_TTL: '0' }, 'PII_SERVICE_VAULT_TTL must be an integer of at least 1.'],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'gemini' },
      'PII_SERVICE_MODEL_PROVIDER must be one of ollama, generic, mistral, openai, anthropic.',
    ],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'openai' },
      'Set OPENAI_API_KEY in the environment of the server to use this provider.',
    ],
    [{ PII_SERVICE_MODEL_PROVIDER: 'generic' }, 'Choose a model first.'],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'generic', PII_SERVICE_MODEL: 'm' },
      'Enter the URL of the OpenAI-compatible server.',
    ],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'ollama', PII_SERVICE_MODEL_URL: 'ftp://x' },
      'The server URL must start with http:// or https://.',
    ],
    [
      { PII_SERVICE_MODEL_PROVIDER: 'mistral', MISTRAL_API_KEY: 'k' },
      'mistral is an external provider: detection sends the unredacted text there. Set PII_SERVICE_ACKNOWLEDGE_EXTERNAL=true after checking the data processing agreement and third-country transfers.',
    ],
  ])('rejects %j', async (env, message) => {
    const error = await serviceFromEnv(env).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe(message);
  });

  it('configures model detection from the environment', async () => {
    const ollama = await serviceFromEnv({ PII_SERVICE_MODEL_PROVIDER: 'ollama' });
    expect(ollama.api.modelDetection).toBe(true);

    const external = await serviceFromEnv({
      PII_SERVICE_MODEL_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'k',
      PII_SERVICE_ACKNOWLEDGE_EXTERNAL: 'true',
    });
    expect(external.api.modelDetection).toBe(true);
  });

  it('detects with a (fake, local) Ollama server', async () => {
    const requests: unknown[] = [];
    const fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        requests.push({ path: req.url, body: JSON.parse(body) as unknown });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ message: { content: '{"entities":[{"type":"PERSON","value":"Johann Beispielmann"}]}' } }),
        );
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = fake.address() as AddressInfo;
      const service = await serviceFromEnv({
        PII_SERVICE_MODEL_PROVIDER: 'ollama',
        PII_SERVICE_MODEL: 'test-model',
        PII_SERVICE_MODEL_URL: `http://127.0.0.1:${String(port)}`,
      });
      const response = await service.api.operation('redact', {
        text: 'Johann Beispielmann zahlt.',
        detection: 'model',
      });

      expect(response.body).toMatchObject({ text: '⟦PERSON_1⟧ zahlt.' });
      expect(requests).toMatchObject([{ path: '/api/chat', body: { model: 'test-model' } }]);
    } finally {
      fake.close();
    }
  });
});

describe('model providers', () => {
  const prompt: ModelPrompt = { system: 'S', user: 'U' };
  const signal = new AbortController().signal;

  function fakeFetch(answer: unknown, status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: typeof globalThis.fetch = (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });

      return Promise.resolve(new Response(JSON.stringify(answer), { status }));
    };

    return { calls, fetch };
  }
  const bodyOf = (init: RequestInit) => JSON.parse(init.body as string) as Record<string, unknown>;

  it('calls Ollama’s chat API without reasoning, deterministic, local for localhost', async () => {
    const { calls, fetch } = fakeFetch({ message: { content: '{"entities":[]}' } });
    const { model, location } = providerModel({ provider: 'ollama', fetch });

    expect(location).toBe(ModelLocation.Local);
    expect(model.name).toBe('qwen3:4b-instruct');
    expect(await model.generate(prompt, { signal })).toBe('{"entities":[]}');
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(bodyOf(calls[0]?.init ?? {})).toEqual({
      model: 'qwen3:4b-instruct',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ],
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 1024 },
    });
    expect(providerModel({ provider: 'ollama', endpoint: 'http://gpu.example:11434/' }).location).toBe(
      ModelLocation.OnPremise,
    );
    expect(providerModel({ provider: 'ollama', endpoint: 'http://host.docker.internal:11434' }).location).toBe(
      ModelLocation.Local,
    );
  });

  it('calls an OpenAI-compatible server (base URL with or without /v1)', async () => {
    const { calls, fetch } = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
    const { model, location } = providerModel({
      provider: 'generic',
      endpoint: 'https://llm.example/v1/',
      model: 'llama',
      apiKey: 'k',
      fetch,
    });

    expect(location).toBe(ModelLocation.OnPremise);
    expect(await model.generate(prompt, { signal })).toBe('ok');
    expect(calls[0]?.url).toBe('https://llm.example/v1/chat/completions');
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer k' });
    expect(bodyOf(calls[0]?.init ?? {})).toMatchObject({
      model: 'llama',
      temperature: 0,
      reasoning_effort: 'none',
      max_tokens: 1024,
    });
  });

  it('calls OpenAI, Mistral and Anthropic as external providers', async () => {
    const openai = fakeFetch({ choices: [{ message: { content: 'a' } }] });
    const o = providerModel({ provider: 'openai', apiKey: 'k', fetch: openai.fetch });
    expect(o.location).toBe(ModelLocation.External);
    await o.model.generate(prompt, { signal });
    expect(openai.calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(bodyOf(openai.calls[0]?.init ?? {})).not.toHaveProperty('temperature');

    const mistral = fakeFetch({ choices: [{ message: { content: 'a' } }] });
    await providerModel({ provider: 'mistral', apiKey: 'k', fetch: mistral.fetch }).model.generate(prompt, { signal });
    expect(mistral.calls[0]?.url).toBe('https://api.mistral.ai/v1/chat/completions');

    const anthropic = fakeFetch({ content: [{ type: 'text', text: 'b' }] });
    const a = providerModel({ provider: 'anthropic', apiKey: 'k', fetch: anthropic.fetch });
    expect(await a.model.generate(prompt, { signal })).toBe('b');
    expect(anthropic.calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(anthropic.calls[0]?.init.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    expect(bodyOf(anthropic.calls[0]?.init ?? {})).toMatchObject({
      system: 'S',
      messages: [{ role: 'user', content: 'U' }],
    });
  });

  it('fails without echoing the provider’s answer', async () => {
    const { fetch } = fakeFetch({ error: 'your text: Johann Beispielmann' }, 400);
    const { model } = providerModel({ provider: 'ollama', fetch });

    await expect(model.generate(prompt, { signal })).rejects.toThrow(/^HTTP 400$/);
    await expect(
      providerModel({ provider: 'ollama', fetch: fakeFetch({}).fetch }).model.generate(prompt, { signal }),
    ).rejects.toThrow('The model answered without text.');
  });

  it('validates endpoints like PHP', () => {
    expect(validEndpoint(' http://x:1/// ')).toBe('http://x:1');
    expect(() => validEndpoint('localhost:11434')).toThrow('The server URL must start with http:// or https://.');
  });
});

describe('pii-shield CLI', () => {
  function captureStderr(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));

      return true;
    });

    return lines;
  }

  it.each([
    [[]],
    [['nope']],
    [['serve', '--http']],
    [['serve', 'extra']],
    [['serve', '--port', 'x']],
    [['serve', '--bogus']],
  ])('prints the usage for %j', async (argv) => {
    const stderr = captureStderr();

    expect(await main(argv, {})).toBe(2);
    expect(stderr.join('')).toMatch(/Usage:|--port must be/);
  });

  it('prints help', async () => {
    const stderr = captureStderr();

    expect(await main(['--help'], {})).toBe(0);
    expect(stderr.join('')).toContain('pii-shield serve');
  });

  it('exits with 1 on a configuration error, without secrets', async () => {
    const stderr = captureStderr();

    expect(await main(['serve'], { PII_SERVICE_VAULT_KEY: 'c2VjcmV0' })).toBe(1);
    expect(stderr.join('')).toBe('pii-shield: PII_SERVICE_VAULT_KEY must be 32 bytes, base64-encoded.\n');
  });

  it('serves /v1 and /mcp until SIGTERM', async () => {
    const stderr = captureStderr();
    const running = main(['serve', '--port', '0'], { PII_SERVICE_TOKEN: 'secret' });
    await expect.poll(() => stderr.join('')).toMatch(/listening on (http:\S+) \(\/v1, \/mcp\)/);
    const url = /listening on (http:\S+)/.exec(stderr.join(''))?.[1] ?? '';

    expect(
      await postJson(url, '/v1/mask', { text: 'SVNR 4568 150392' }, { Authorization: 'Bearer secret' }),
    ).toMatchObject({
      status: 200,
      json: { text: 'SVNR [SVNR]' },
    });
    expect(
      (
        await rawRequest(url, {
          method: 'POST',
          path: '/mcp',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(401);

    process.emit('SIGTERM');
    expect(await running).toBe(0);
    expect(stderr.join('')).toContain('shutting down');
  });

  it('serves only /mcp with mcp --http', async () => {
    const stderr = captureStderr();
    const running = main(['mcp', '--http', '--port', '0'], {});
    await expect.poll(() => stderr.join('')).toMatch(/listening on (http:\S+) \(\/mcp\)/);
    const url = /listening on (http:\S+)/.exec(stderr.join(''))?.[1] ?? '';

    expect((await postJson(url, '/v1/mask', { text: 'x' })).status).toBe(404);
    process.emit('SIGINT');
    expect(await running).toBe(0);
  });
});
