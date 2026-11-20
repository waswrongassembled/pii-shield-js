import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseJsonBody } from '../service/json-body.js';
import type { ServiceApi, ServiceResponse } from '../service/service-api.js';

/** Serves /mcp (Streamable HTTP); see `createMcpHttpHandler()` in `@waswrongassembled/pii-shield/mcp`. */
export interface McpHttpHandler {
  /** Answers one request to /mcp; the request guard has already checked host, origin and access. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Closes all MCP sessions. */
  close(): Promise<void>;
}

export interface RequestListenerOptions {
  api: ServiceApi;
  /** Serve /v1 (default true). */
  v1?: boolean;
  /** Serve /mcp with this handler (default: no /mcp). */
  mcp?: McpHttpHandler | undefined;
  /** Host names to answer besides 127.0.0.1, localhost and [::1] (PII_SERVICE_ALLOWED_HOSTS). */
  allowedHosts?: Iterable<string>;
  /** Largest request body in bytes, default 2 MiB (a 100,000 character text fits even fully escaped). */
  maxBodyBytes?: number;
  /** Browser origins allowed on /mcp besides the server's own; default the MCP Inspector's. */
  mcpBrowserOrigins?: Iterable<string>;
  /** Called with unexpected errors (500); never receives request text. */
  onError?: (error: unknown) => void;
}

export interface ServerOptions extends RequestListenerOptions {
  /** Default 8088. 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
}

/** A started server; `close()` stops it gracefully. */
export interface PiiShieldServer {
  readonly server: Server;
  /** e.g. "http://127.0.0.1:8088" */
  readonly url: string;
  readonly address: AddressInfo;
  /**
   * Stops accepting connections, closes MCP sessions and waits for running requests, at most
   * `timeoutMs` (default 10000), then closes the remaining connections.
   */
  close(timeoutMs?: number): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Browser-based MCP tools allowed besides same-origin requests (the MCP Inspector's default). */
export const MCP_BROWSER_ORIGINS: readonly string[] = Object.freeze(['http://localhost:6274', 'http://127.0.0.1:6274']);

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const OPENAPI_PATH = '/v1/openapi.yaml';
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

let openapi: Promise<string> | undefined;

/** docs/openapi.yaml of this package, served at /v1/openapi.yaml. */
export function openapiDocument(): Promise<string> {
  openapi ??= readFile(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8');

  return openapi;
}

/**
 * The request listener of the pii-shield service: /v1 (ServiceApi) and optionally /mcp, behind the
 * checks of PHP's RequestGuard:
 *
 * - only known host names (DNS rebinding): 421;
 * - POST only as `application/json`, no foreign browser Origin (CSRF): 403;
 * - /v1 and /mcp need the bearer token, or come from a local peer when no token is configured;
 * - security headers on every response, no CORS.
 *
 * Mount it in your own `node:http` server or use `startServer()`.
 */
export function createRequestListener(
  options: RequestListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const { api, v1 = true, mcp, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;
  const hosts = new Set([...LOCAL_HOSTS, ...[...(options.allowedHosts ?? [])].map((h) => h.toLowerCase())]);
  const mcpOrigins = new Set(options.mcpBrowserOrigins ?? MCP_BROWSER_ORIGINS);
  const onError =
    options.onError ??
    (() => {
      // silent by default
    });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    const method = req.method ?? 'GET';
    const path = rawUrlDecode((req.url ?? '/').replace(/[?#].*$/s, ''));
    const isMcp = mcp !== undefined && path === '/mcp';
    const isOpenapi = v1 && path === OPENAPI_PATH && (method === 'GET' || method === 'HEAD');
    const isV1 = v1 && path.startsWith('/v1/') && path.length > '/v1/'.length;
    if (!isMcp && !isV1) {
      send(res, { status: 404, body: { error: 'Not found.' } });

      return;
    }

    const host = parseHost(req.headers.host);
    if (!hosts.has(host.name)) {
      send(res, { status: 421, body: { error: 'Unknown host.' } });

      return;
    }
    const origin = req.headers.origin;
    const foreignOrigin = origin !== undefined && origin !== host.origin && !(isMcp && mcpOrigins.has(origin));
    const notJson = method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json');
    if (foreignOrigin || notJson) {
      send(res, {
        status: 403,
        body: { error: 'Send JSON (Content-Type: application/json) from a non-browser client or this page.' },
      });

      return;
    }

    if (isMcp) {
      const denied = api.checkAccess(req.headers.authorization, req.socket.remoteAddress);
      if (denied !== null) {
        send(res, denied);

        return;
      }
      await mcp.handle(req, res);

      return;
    }
    if (isOpenapi) {
      res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : await openapiDocument());

      return;
    }

    let body = null;
    if (method === 'POST') {
      const bytes = await readBody(req, maxBodyBytes);
      if (bytes === null) {
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.socket.destroy());
        send(res, { status: 413, body: { error: 'The request body is too large.' } });

        return;
      }
      const parsed = parseJsonBody(bytes);
      if (!parsed.ok) {
        send(res, { status: 400, body: { error: parsed.error } });

        return;
      }
      body = parsed.body;
    }

    const aborted = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) {
        aborted.abort(new Error('The client closed the connection.'));
      }
    };
    res.once('close', onClose);
    try {
      send(
        res,
        await api.handle({
          method,
          path,
          body,
          authorization: req.headers.authorization,
          remoteAddress: req.socket.remoteAddress,
          signal: aborted.signal,
        }),
      );
    } finally {
      res.off('close', onClose);
    }
  }

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent && !res.destroyed) {
        onError(e);
        send(res, { status: 500, body: { error: 'Internal server error.' } });
      } else if (!res.destroyed) {
        onError(e);
        res.destroy();
      }
    });
  };
}

/** Starts the service on `host:port` (default 127.0.0.1:8088). */
export async function startServer(options: ServerOptions): Promise<PiiShieldServer> {
  const { port = 8088, host = '127.0.0.1' } = options;
  const server = createHttpServer(createRequestListener(options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const urlHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let closing: Promise<void> | undefined;
  // While closing, a connection that finishes its response is closed instead of kept alive.
  server.on('request', (_req: IncomingMessage, res: ServerResponse) => {
    res.once('finish', () => {
      if (closing !== undefined) {
        setImmediate(() => {
          server.closeIdleConnections();
        });
      }
    });
  });

  const close = (timeoutMs = 10_000): Promise<void> => {
    closing ??= (async () => {
      const closed = new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      server.closeIdleConnections();
      await options.mcp?.close();
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, timeoutMs);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    })();

    return closing;
  };

  return {
    server,
    url: `http://${urlHost}:${String(address.port)}`,
    address,
    close,
    [Symbol.asyncDispose]: () => close(),
  };
}

function send(res: ServerResponse, response: ServiceResponse): void {
  if (response.status === 204 || response.body === null) {
    res.writeHead(response.status);
    res.end();

    return;
  }
  const json = JSON.stringify(response.body);
  res.writeHead(response.status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/** Reads the body; null when it is larger than `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) {
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      return null;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * The Host header as Symfony sees it: the lower-case name without port, and the request's own origin
 * (`http://` + name, plus the port unless it is 80).
 */
function parseHost(header: string | undefined): { name: string; origin: string } {
  const value = (header ?? '').toLowerCase();
  const port = /:(\d+)$/.exec(value);
  const name = port === null ? value : value.slice(0, port.index);
  const origin = port === null || port[1] === '80' ? `http://${name}` : `http://${name}:${port[1] ?? ''}`;

  return { name, origin };
}

/** PHP's rawurldecode(): %XX sequences become bytes, everything else stays. */
function rawUrlDecode(path: string): string {
  if (!path.includes('%')) {
    return path;
  }
  const bytes: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const hex = path.slice(i + 1, i + 3);
    if (path[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(path[i] ?? '', 'utf8'));
    }
  }

  return Buffer.from(bytes).toString('utf8');
}
