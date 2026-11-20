/**
 * The `pii-shield` command: the HTTP service (`serve`) and the MCP server (`mcp`), configured from
 * environment variables (docs/server.md).
 */
import { parseArgs } from 'node:util';

import { ConfigError, serviceFromEnv } from './server/config.js';
import { type McpHttpHandler, startServer } from './server/http-server.js';
import type { ServiceApi } from './service/service-api.js';

const USAGE = `Usage:
  pii-shield serve [--port <port>] [--host <host>]   HTTP service: /v1 (and /mcp if @modelcontextprotocol/sdk is installed)
  pii-shield mcp                                      MCP server over STDIO
  pii-shield mcp --http [--port <port>] [--host <host>]   MCP server over Streamable HTTP (/mcp)

Configuration: environment variables, see docs/server.md (PII_SERVICE_TOKEN, PII_SERVICE_VAULT_KEY, ...).`;

/** Runs the CLI; resolves with the exit code once a server stops (or at once on an error). */
export async function main(
  argv: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        http: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}\n`);

    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help === true || command === undefined) {
    process.stderr.write(`${USAGE}\n`);

    return values.help === true ? 0 : 2;
  }
  if (
    positionals.length > 1 ||
    (command !== 'serve' && command !== 'mcp') ||
    (command === 'serve' && values.http === true)
  ) {
    process.stderr.write(`${USAGE}\n`);

    return 2;
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    process.stderr.write('--port must be a port number.\n');

    return 2;
  }

  let service;
  try {
    service = await serviceFromEnv(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`pii-shield: ${e.message}\n`);

      return 1;
    }
    throw e;
  }
  for (const note of service.notes) {
    process.stderr.write(`pii-shield: ${note}\n`);
  }
  const onError = (error: unknown) => {
    // Name and code only: messages of provider errors may quote the request text.
    const { name = 'Error', code } = (error ?? {}) as { name?: string; code?: unknown };
    process.stderr.write(`pii-shield: request failed (${name}${typeof code === 'string' ? ` ${code}` : ''})\n`);
  };

  if (command === 'mcp' && values.http !== true) {
    const mcp = await loadMcp();
    if (mcp === null) {
      await service.close();

      return 1;
    }
    const server = await mcp.serveStdio(service.api);
    await new Promise<void>((resolve) => {
      server.server.onclose = resolve;
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await server.close();
    await service.close();

    return 0;
  }

  const mcp = await loadMcp(command === 'serve');
  if (mcp === null && command === 'mcp') {
    await service.close();

    return 1;
  }
  const server = await startServer({
    api: service.api,
    v1: command === 'serve',
    mcp: mcp === null ? undefined : mcp.createMcpHttpHandler(service.api, { maxBodyBytes: service.maxBodyBytes }),
    allowedHosts: service.allowedHosts,
    maxBodyBytes: service.maxBodyBytes,
    port: port ?? service.port,
    host: values.host ?? service.host,
    onError,
  });
  process.stderr.write(
    `pii-shield: listening on ${server.url}${command === 'serve' ? ' (/v1' : ' ('}${mcp === null ? '' : command === 'serve' ? ', /mcp' : '/mcp'})\n`,
  );
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  process.stderr.write('pii-shield: shutting down\n');
  await server.close();
  await service.close();

  return 0;
}

async function loadMcp(optional = false): Promise<{
  serveStdio: (api: ServiceApi) => Promise<{ close(): Promise<void>; server: { onclose?: (() => void) | undefined } }>;
  createMcpHttpHandler: (api: ServiceApi, options: { maxBodyBytes: number }) => McpHttpHandler;
} | null> {
  try {
    return await import('./mcp/index.js');
  } catch (e) {
    if ((e as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') {
      throw e;
    }
    process.stderr.write(
      optional
        ? 'pii-shield: /mcp is off (install @modelcontextprotocol/sdk to enable it)\n'
        : 'pii-shield: the MCP server needs the package "@modelcontextprotocol/sdk" (npm install @modelcontextprotocol/sdk)\n',
    );

    return null;
  }
}
