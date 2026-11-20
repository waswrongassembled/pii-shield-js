import { afterEach, describe, expect, it } from 'vitest';

import { DetectionError } from '../src/index.js';
import {
  defaultGateway,
  localPeerMatcher,
  parseJsonBody,
  type PiiShieldServer,
  type ServerOptions,
  startServer,
} from '../src/server/index.js';
import { postJson, rawRequest } from './support/http.js';
import { serviceApi, TOKEN } from './support/service.js';

const servers: PiiShieldServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(options: Partial<ServerOptions> = {}): Promise<PiiShieldServer> {
  const server = await startServer({ api: serviceApi({ token: undefined }), port: 0, ...options });
  servers.push(server);

  return server;
}

/** Port of PHP's tests/Demo/ServerTest (the parts without the demo page) and RequestGuard. */
describe('HTTP server', () => {
  it('serves /v1 to local peers without a token, readable in a terminal', async () => {
    const { url } = await start();
    const response = await postJson(url, '/v1/redact', { text: 'SVNR 4568 150392' });

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ text: 'SVNR ⟦SVNR_1⟧' });
    expect(response.text).toContain('"SVNR ⟦SVNR_1⟧"');
    expect(response.headers['content-type']).toBe('application/json');

    const spec = await rawRequest(url, { path: '/v1/openapi.yaml' });
    expect(spec.status).toBe(200);
    expect(spec.text.startsWith('openapi: 3.1.0')).toBe(true);
  });

  it('sets security headers and no CORS', async () => {
    const { url } = await start();
    for (const response of [
      await rawRequest(url, { path: '/v1/health' }),
      await rawRequest(url, { path: '/nope' }),
      await postJson(url, '/v1/mask', { text: 'x' }),
    ]) {
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('serves only /v1', async () => {
    const { url } = await start();

    for (const path of ['/', '/v1', '/v1/', '/mcp', '/api/analyze', '/index.html']) {
      const response = await rawRequest(url, { path });
      expect(response.status, path).toBe(404);
      expect(response.json).toEqual({ error: 'Not found.' });
    }
  });

  it('answers the token rules: 401 for other peers, 503 in service mode', async () => {
    const remote = await start({ api: serviceApi({ token: undefined, isLocalPeer: () => false }) });
    expect((await postJson(remote.url, '/v1/redact', { text: 'x' })).status).toBe(401);

    const serviceMode = await start({ api: serviceApi({ token: undefined, requireToken: true }) });
    expect(await postJson(serviceMode.url, '/v1/mask', { text: 'x' })).toMatchObject({
      status: 503,
      json: { error: 'Set PII_SERVICE_TOKEN to use this service.' },
    });

    const withToken = await start({ api: serviceApi({ token: TOKEN, requireToken: true }) });
    expect((await postJson(withToken.url, '/v1/mask', { text: 'SVNR 4568 150392' })).status).toBe(401);
    expect(
      await postJson(withToken.url, '/v1/mask', { text: 'SVNR 4568 150392' }, { Authorization: `Bearer ${TOKEN}` }),
    ).toMatchObject({ status: 200, json: { text: 'SVNR [SVNR]' } });
  });

  it('rejects unknown hosts (DNS rebinding)', async () => {
    const { url, address } = await start({ allowedHosts: ['pii.example'] });

    expect(await postJson(url, '/v1/mask', { text: 'x' }, { Host: 'evil.example' })).toMatchObject({
      status: 421,
      json: { error: 'Unknown host.' },
    });
    expect((await rawRequest(url, { path: '/v1/health', headers: { Host: 'evil.example' } })).status).toBe(421);
    expect((await rawRequest(url, { path: '/v1/health', headers: { Host: 'pii.example' } })).status).toBe(200);
    expect(
      (await rawRequest(url, { path: '/v1/health', headers: { Host: `LOCALHOST:${String(address.port)}` } })).status,
    ).toBe(200);
    expect((await rawRequest(url, { path: '/v1/health', headers: { Host: '[::1]:1' } })).status).toBe(200);
  });

  it('rejects non-JSON and foreign origins (CSRF)', async () => {
    const { url, address } = await start();
    const message = { error: 'Send JSON (Content-Type: application/json) from a non-browser client or this page.' };

    expect(
      await rawRequest(url, {
        method: 'POST',
        path: '/v1/mask',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"text":"x"}',
      }),
    ).toMatchObject({ status: 403, json: message });
    expect(await rawRequest(url, { method: 'POST', path: '/v1/mask', body: '{"text":"x"}' })).toMatchObject({
      status: 403,
    });
    expect(await postJson(url, '/v1/mask', { text: 'x' }, { Origin: 'http://evil.example' })).toMatchObject({
      status: 403,
      json: message,
    });
    expect((await rawRequest(url, { path: '/v1/health', headers: { Origin: 'null' } })).status).toBe(403);
    // The MCP Inspector's origin is only accepted on /mcp.
    expect((await postJson(url, '/v1/mask', { text: 'x' }, { Origin: 'http://localhost:6274' })).status).toBe(403);

    const own = `http://127.0.0.1:${String(address.port)}`;
    expect((await postJson(url, '/v1/mask', { text: 'x' }, { Origin: own })).status).toBe(200);
    expect(
      (await postJson(url, '/v1/mask', { text: 'x' }, { 'Content-Type': 'application/json; charset=utf-8' })).status,
    ).toBe(200);
  });

  it('cannot be bypassed with encoded paths', async () => {
    const { url } = await start();

    expect(
      (
        await rawRequest(url, {
          method: 'POST',
          path: '/%76%31/mask',
          headers: { 'Content-Type': 'text/plain' },
          body: '{"text":"x"}',
        })
      ).status,
    ).toBe(403);
    expect((await postJson(url, '/v1/%6Dask', { text: 'SVNR 4568 150392' })).json).toEqual({ text: 'SVNR [SVNR]' });
    expect((await postJson(url, '/v1/mask?x=1', { text: 'SVNR 4568 150392' })).json).toEqual({ text: 'SVNR [SVNR]' });
  });

  it.each([
    ['{', 'Invalid JSON.'],
    ['', 'Invalid JSON.'],
    ['"text"', 'Expected a JSON object.'],
    ['42', 'Expected a JSON object.'],
    ['null', 'Expected a JSON object.'],
    ['{"text":"\\ud800"}', 'Invalid JSON.'],
    [`${'['.repeat(16)}${']'.repeat(16)}`, 'Invalid JSON.'],
    ['\u{FEFF}{"text":"x"}', 'Invalid JSON.'],
  ])('rejects the body %j', async (body, error) => {
    const { url } = await start();

    expect(
      await rawRequest(url, {
        method: 'POST',
        path: '/v1/mask',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    ).toMatchObject({ status: 400, json: { error } });
  });

  it('rejects invalid UTF-8', async () => {
    const { url } = await start();
    const body = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);

    expect(
      await rawRequest(url, {
        method: 'POST',
        path: '/v1/mask',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    ).toMatchObject({ status: 400, json: { error: 'Invalid JSON.' } });
  });

  it('rejects bodies over the size limit with 413', async () => {
    const { url } = await start({ maxBodyBytes: 1000 });

    expect(await postJson(url, '/v1/mask', { text: 'x'.repeat(2000) })).toMatchObject({
      status: 413,
      json: { error: 'The request body is too large.' },
    });
    expect((await postJson(url, '/v1/mask', { text: 'x'.repeat(900) })).status).toBe(200);
  });

  it('answers 204 without a body', async () => {
    const { url } = await start();
    const response = await rawRequest(url, { method: 'DELETE', path: `/v1/vault/${'a'.repeat(32)}` });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it('hides unexpected errors behind a generic 500 and reports them', async () => {
    const errors: unknown[] = [];
    const { url } = await start({
      api: serviceApi({
        token: undefined,
        modelDetector: () => {
          throw new TypeError('boom with details');
        },
      }),
      onError: (e) => errors.push(e),
    });

    expect(await postJson(url, '/v1/mask', { text: 'x', detection: 'model' })).toMatchObject({
      status: 500,
      json: { error: 'Internal server error.' },
    });
    expect(errors).toEqual([new TypeError('boom with details')]);
  });

  it('aborts model detection when the client goes away', async () => {
    let signal: AbortSignal | undefined;
    const { url } = await start({
      api: serviceApi({
        token: undefined,
        modelDetector: () => ({
          async: true,
          detect: (_text, options) => {
            signal = options?.signal;

            return new Promise((_, reject) => {
              options?.signal?.addEventListener('abort', () => {
                reject(new DetectionError('aborted', 'DETECTION_MODEL_UNREACHABLE'));
              });
            });
          },
        }),
      }),
    });
    const controller = new AbortController();
    const pending = fetch(`${url}/v1/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x', detection: 'model' }),
      signal: controller.signal,
    }).catch(() => null);
    await expect.poll(() => signal).toBeDefined();
    controller.abort();
    await pending;

    await expect.poll(() => signal?.aborted).toBe(true);
  });

  it('closes gracefully and waits for running requests', async () => {
    let release: (() => void) | undefined;
    const server = await startServer({
      api: serviceApi({
        token: undefined,
        modelDetector: () => ({
          async: true,
          detect: () =>
            new Promise<never[]>((resolve) => {
              release = () => {
                resolve([]);
              };
            }),
        }),
      }),
      port: 0,
    });
    const pending = postJson(server.url, '/v1/mask', { text: 'x', detection: 'model' });
    await expect.poll(() => release).toBeDefined();
    const closed = server.close();
    release?.();

    expect(await pending).toMatchObject({ status: 200, json: { text: 'x' } });
    await closed;
    await expect(postJson(server.url, '/v1/mask', { text: 'x' })).rejects.toThrow();
  });
});

/** Port of PHP's tests/Demo/LocalPeerTest. */
describe('local peers', () => {
  it('reads the default gateway from the route table', () => {
    const routes =
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
      'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n' +
      'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n';

    expect(defaultGateway(routes)).toBe('172.17.0.1');
  });

  it('has no gateway without a default route', () => {
    expect(defaultGateway('Iface\tDestination\tGateway\n')).toBeNull();
    expect(defaultGateway('')).toBeNull();
  });

  it('always treats loopback as local', () => {
    const isLocal = localPeerMatcher();

    expect(isLocal('127.0.0.1')).toBe(true);
    expect(isLocal('::1')).toBe(true);
    expect(isLocal('::ffff:127.0.0.1')).toBe(true);
    expect(isLocal('127.0.0.2')).toBe(false);
    expect(isLocal('172.17.0.1')).toBe(false);
    expect(isLocal(undefined)).toBe(false);
    expect(isLocal('not an ip')).toBe(false);
  });

  it('adds configured peers, CIDRs and the Docker gateway', () => {
    const routes = 'Iface\tDestination\tGateway\neth0\t00000000\t01581FAC\t0003\n';
    const isLocal = localPeerMatcher(
      [' 10.1.0.0/16 ', 'gateway', 'fd00::/8', 'nonsense', '10.9.9.9/33', ''],
      () => routes,
    );

    expect(isLocal('172.31.88.1')).toBe(true);
    expect(isLocal('172.31.88.7')).toBe(false);
    expect(isLocal('10.1.200.3')).toBe(true);
    expect(isLocal('::ffff:10.1.200.3')).toBe(true);
    expect(isLocal('10.2.0.1')).toBe(false);
    expect(isLocal('10.9.9.9')).toBe(false);
    expect(isLocal('fd12::1')).toBe(true);
  });

  it('ignores the gateway without a route table', () => {
    const isLocal = localPeerMatcher(['gateway'], () => {
      throw new Error('ENOENT');
    });

    expect(isLocal('172.17.0.1')).toBe(false);
  });
});

describe('parseJsonBody', () => {
  it('accepts 15 levels and treats a list as an empty object', () => {
    expect(parseJsonBody(Buffer.from(`${'['.repeat(15)}${']'.repeat(15)}`))).toEqual({ ok: true, body: {} });
    expect(parseJsonBody(Buffer.from('{"a":{"b":{}}}'))).toEqual({ ok: true, body: { a: { b: {} } } });
    expect(parseJsonBody(Buffer.from('{"\\udc00":1}'))).toEqual({ ok: false, error: 'Invalid JSON.' });
  });
});
