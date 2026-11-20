import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpHttpHandler, createMcpServer, serveStdio, TOOLS } from '../src/mcp/index.js';
import { type PiiShieldServer, type ServiceApi, startServer } from '../src/server/index.js';
import { postJson, type RawResponse } from './support/http.js';
import { fakeModelDetector, serviceApi, TOKEN } from './support/service.js';

const servers: PiiShieldServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(api: ServiceApi = serviceApi({ token: undefined }), v1 = true): Promise<PiiShieldServer> {
  const server = await startServer({ api, mcp: createMcpHttpHandler(api), v1, port: 0 });
  servers.push(server);

  return server;
}

async function connect(api: ServiceApi = serviceApi({ token: undefined })): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(api).connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);

  return client;
}

const json = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0]?.text ?? '') as Record<string, unknown>;

/** Raw JSON-RPC over Streamable HTTP, as PHP's McpTest does it. */
class RpcSession {
  sessionId: string | undefined;
  constructor(readonly url: string) {}

  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<RawResponse> {
    const response = await postJson(
      this.url,
      '/mcp',
      { jsonrpc: '2.0', id: Math.floor(Math.random() * 1_000_000), method, params },
      {
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId === undefined ? {} : { 'Mcp-Session-Id': this.sessionId }),
        ...headers,
      },
    );
    const header = response.headers['mcp-session-id'];
    this.sessionId ??= Array.isArray(header) ? header[0] : header;

    return response;
  }

  async initialize(headers: Record<string, string> = {}): Promise<RawResponse> {
    const response = await this.rpc(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
      headers,
    );
    await this.rpcNotification('notifications/initialized', headers);

    return response;
  }

  async rpcNotification(method: string, headers: Record<string, string> = {}): Promise<void> {
    await postJson(
      this.url,
      '/mcp',
      { jsonrpc: '2.0', method },
      {
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId === undefined ? {} : { 'Mcp-Session-Id': this.sessionId }),
        ...headers,
      },
    );
  }
}

describe('MCP tools', () => {
  it('lists the tools with PHP’s schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      'redact_text',
      'restore_text',
      'mask_text',
      'learn_entity_type',
      'list_entity_types',
    ]);
    expect(tools).toEqual(TOOLS);
    expect(client.getServerVersion()).toMatchObject({ name: 'pii-shield' });
    expect(client.getInstructions()).toMatch(/^Before giving text with personal data to a model, call redact_text/);
  });

  it('redacts, then restores without sending originals', async () => {
    const client = await connect();
    const redacted = await client.callTool({
      name: 'redact_text',
      arguments: { text: 'Herrn\nJohann Beispielmann\nSVNR 4568 150392' },
    });

    expect(redacted.isError).toBeUndefined();
    expect(json(redacted)).toMatchObject({ text: 'Herrn\n⟦PERSON_1⟧\nSVNR ⟦SVNR_1⟧', expiresIn: 900 });
    expect(redacted.structuredContent).toEqual(json(redacted));
    expect(JSON.stringify(redacted)).not.toContain('Beispielmann');

    const restored = await client.callTool({
      name: 'restore_text',
      arguments: { text: '⟦PERSON_1⟧ / ⟦SVNR_1⟧', vaultId: json(redacted)['vaultId'] },
    });
    expect(json(restored)).toEqual({
      text: 'Johann Beispielmann / 4568 150392',
      unknownPlaceholders: [],
      unusedPlaceholders: [],
    });
  });

  it('pretty-prints the result like PHP (four spaces, unescaped Unicode)', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'mask_text', arguments: { text: 'SVNR 4568 150392 – ok' } });

    expect((result.content as { text: string }[])[0]?.text).toBe('{\n    "text": "SVNR [SVNR] – ok"\n}');
  });

  it('masks, learns and lists', async () => {
    const client = await connect();

    expect(json(await client.callTool({ name: 'mask_text', arguments: { text: 'SVNR 4568 150392' } }))).toEqual({
      text: 'SVNR [SVNR]',
    });
    const preview = json(
      await client.callTool({
        name: 'learn_entity_type',
        arguments: { name: 'MCP_TEST_NUMBER', examples: ['MT-2026-0001', 'MT-2025-0002'], dryRun: true },
      }),
    );
    expect(preview).toMatchObject({ type: { pattern: String.raw`MT-\d{4}-\d{4}` }, saved: false });
    expect(json(await client.callTool({ name: 'list_entity_types', arguments: {} }))).toEqual({ types: [] });

    await client.callTool({
      name: 'learn_entity_type',
      arguments: { name: 'MCP_TEST_NUMBER', examples: ['MT-2026-0001', 'MT-2025-0002'] },
    });
    const listed = json(await client.callTool({ name: 'list_entity_types' }));
    expect(listed).toEqual({
      types: [
        {
          name: 'MCP_TEST_NUMBER',
          description: '',
          examples: ['MT-2026-0001', 'MT-2025-0002'],
          counterExamples: [],
          pattern: String.raw`MT-\d{4}-\d{4}`,
        },
      ],
    });
    expect(json(await client.callTool({ name: 'mask_text', arguments: { text: 'Nr. MT-2024-1234' } }))).toEqual({
      text: 'Nr. [MCP_TEST_NUMBER]',
    });
  });

  it('uses the configured model on request', async () => {
    const client = await connect(serviceApi({ modelDetector: fakeModelDetector() }));
    const result = await client.callTool({
      name: 'redact_text',
      arguments: { text: 'Johann Beispielmann zahlt.', detection: 'model' },
    });

    expect(json(result)['text']).toBe('⟦PERSON_1⟧ zahlt.');
  });

  it('returns errors as tool results, not crashes', async () => {
    const client = await connect();

    expect(await client.callTool({ name: 'restore_text', arguments: { text: 'x', vaultId: '0'.repeat(32) } })).toEqual({
      content: [{ type: 'text', text: 'Unknown or expired vault id. Redact the text again.' }],
      isError: true,
    });
    expect(await client.callTool({ name: 'redact_text', arguments: { text: 'x', detection: 'model' } })).toMatchObject({
      content: [{ type: 'text', text: 'Model-based detection is not configured on this server.' }],
      isError: true,
    });
    expect(
      await client.callTool({ name: 'learn_entity_type', arguments: { name: 'IBAN', examples: ['x'] } }),
    ).toMatchObject({
      isError: true,
    });
  });

  it.each([
    ['redact_text', {}, "Invalid parameters for tool 'redact_text': Missing required properties: `text`."],
    [
      'redact_text',
      { text: 42 },
      "Invalid parameters for tool 'redact_text': Property '/text': Invalid type. Expected `string`, but received `integer`.",
    ],
    [
      'redact_text',
      { text: 'x', detection: 'nope' },
      'Invalid parameters for tool \'redact_text\': Property \'/detection\': Value must be one of the allowed values: "regex", "model", "both".',
    ],
    [
      'learn_entity_type',
      { name: 'lower', examples: ['a'] },
      "Invalid parameters for tool 'learn_entity_type': Property '/name': String does not match the required pattern: `^[A-Z][A-Z0-9_]{1,39}$`.",
    ],
    [
      'learn_entity_type',
      { name: 'ABC', examples: [1] },
      "Invalid parameters for tool 'learn_entity_type': Property '/examples/0': Invalid type. Expected `string`, but received `integer`.",
    ],
    [
      'learn_entity_type',
      { name: 'ABC', examples: 'a', dryRun: 'yes' },
      "Invalid parameters for tool 'learn_entity_type': Property '/examples': Invalid type. Expected `array`, but received `string`.",
    ],
    ['nope', {}, 'Tool not found: "nope".'],
  ])('rejects %s %j as invalid params (PHP’s messages)', async (name, args, message) => {
    const client = await connect();

    await expect(client.callTool({ name, arguments: args })).rejects.toMatchObject({
      code: -32602,
      message: `MCP error -32602: ${message}`,
    });
  });

  it('ignores unknown arguments', async () => {
    const client = await connect();

    expect(
      json(await client.callTool({ name: 'mask_text', arguments: { text: 'SVNR 4568 150392', extra: 1 } })),
    ).toEqual({
      text: 'SVNR [SVNR]',
    });
  });
});

describe('MCP over Streamable HTTP', () => {
  it('opens a session and lists the tools (raw JSON-RPC)', async () => {
    const session = new RpcSession((await start()).url);
    const init = await session.initialize();

    expect(init.status).toBe(200);
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const tools = await session.rpc('tools/list');
    expect((tools.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort()).toEqual([
      'learn_entity_type',
      'list_entity_types',
      'mask_text',
      'redact_text',
      'restore_text',
    ]);
  });

  it('redacts and restores with the SDK client', async () => {
    const { url } = await start();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));

    const redacted = json(
      await client.callTool({
        name: 'redact_text',
        arguments: { text: 'Herrn\nJohann Beispielmann\nSVNR 4568 150392' },
      }),
    );
    expect(redacted['text']).toBe('Herrn\n⟦PERSON_1⟧\nSVNR ⟦SVNR_1⟧');
    const restored = json(
      await client.callTool({ name: 'restore_text', arguments: { text: '⟦PERSON_1⟧', vaultId: redacted['vaultId'] } }),
    );
    expect(restored['text']).toBe('Johann Beispielmann');
    await client.close();
  });

  it('rejects foreign origins and non-JSON', async () => {
    const { url } = await start();
    const body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';

    expect((await postJson(url, '/mcp', JSON.parse(body), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await postJson(url, '/mcp', JSON.parse(body), { 'Content-Type': 'text/plain' })).status).toBe(403);
    expect((await postJson(url, '/mcp', JSON.parse(body), { Host: 'evil.example' })).status).toBe(421);
  });

  it('lets local browser tools like the Inspector connect, without CORS wildcard', async () => {
    const session = new RpcSession((await start()).url);
    await session.initialize({ Origin: 'http://localhost:6274' });
    const tools = await session.rpc('tools/list', {}, { Origin: 'http://localhost:6274' });

    expect(tools.status).toBe(200);
    expect(tools.json).toHaveProperty('result');
    expect(tools.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('requires the token when configured, and 503 in service mode without one', async () => {
    const withToken = new RpcSession((await start(serviceApi({ token: 'secret-token' }))).url);
    expect((await withToken.initialize()).status).toBe(401);
    expect((await withToken.initialize({ Authorization: 'Bearer secret-token' })).status).toBe(200);

    const serviceMode = new RpcSession((await start(serviceApi({ token: undefined, requireToken: true }))).url);
    expect((await serviceMode.initialize()).json).toEqual({ error: 'Set PII_SERVICE_TOKEN to use this service.' });

    const remote = new RpcSession((await start(serviceApi({ token: undefined, isLocalPeer: () => false }))).url);
    expect((await remote.initialize()).status).toBe(401);
  });

  it('rejects unknown sessions and requests without one', async () => {
    const session = new RpcSession((await start()).url);
    session.sessionId = 'not-a-session';
    expect((await session.rpc('tools/list')).status).toBe(404);

    const none = new RpcSession(session.url);
    expect((await none.rpc('tools/list')).status).toBe(400);
  });

  it('can serve /mcp without /v1', async () => {
    const { url } = await start(serviceApi({ token: TOKEN }), false);

    expect((await postJson(url, '/v1/mask', { text: 'x' }, { Authorization: `Bearer ${TOKEN}` })).status).toBe(404);
    expect((await new RpcSession(url).initialize({ Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('closes old sessions beyond the limit', async () => {
    const api = serviceApi({ token: undefined });
    const server = await startServer({ api, mcp: createMcpHttpHandler(api, { maxSessions: 2 }), port: 0 });
    servers.push(server);
    const sessions = [new RpcSession(server.url), new RpcSession(server.url), new RpcSession(server.url)];
    for (const s of sessions) {
      await s.initialize();
    }

    expect((await sessions[0]?.rpc('tools/list'))?.status).toBe(404);
    expect((await sessions[2]?.rpc('tools/list'))?.status).toBe(200);
  });
});

describe('MCP over STDIO', () => {
  it('answers on stdout', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const server = await serveStdio(serviceApi({ token: undefined }), { stdin, stdout });
    const lines: unknown[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk
        .toString('utf8')
        .split('\n')
        .filter((l) => l !== '')) {
        lines.push(JSON.parse(line));
      }
    });

    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`,
    );
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mask_text', arguments: { text: 'SVNR 4568 150392' } } })}\n`,
    );

    await expect.poll(() => lines.length).toBe(2);
    expect(lines[1]).toMatchObject({ id: 2, result: { structuredContent: { text: 'SVNR [SVNR]' } } });
    await server.close();
  });
});
