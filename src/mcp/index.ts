/**
 * @waswrongassembled/pii-shield/mcp: the pii-shield MCP server (optional peer `@modelcontextprotocol/sdk`).
 *
 * Tools `redact_text`, `restore_text`, `mask_text`, `learn_entity_type` and `list_entity_types`, as in
 * PHP's PiiShieldTools, over STDIO or Streamable HTTP. The mapping stays on the server: redact_text
 * returns placeholders and a vaultId. restore_text returns the original values to the MCP client, and in
 * an agent the client is the model: call it only where the model may see the data.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable, Writable } from 'node:stream';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { McpHttpHandler } from '../server/http-server.js';
import type { ServiceApi } from '../service/service-api.js';
import { callTool, InvalidToolCall, SERVER_INFO, SERVER_INSTRUCTIONS, TOOLS } from './tools.js';

export {
  callTool,
  InvalidToolCall,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  type ToolDefinition,
  type ToolResult,
  TOOLS,
} from './tools.js';

/**
 * An MCP server with the pii-shield tools on top of a ServiceApi. One server serves one transport
 * (connect it with `server.connect(transport)`); the API can be shared.
 */
export function createMcpServer(api: ServiceApi): McpServer {
  const mcp = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS });
  // The low-level handlers keep PHP's exact JSON schemas (McpServer.registerTool() wants zod schemas).
  mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((tool) => structuredClone(tool) as (typeof TOOLS)[number] & Record<string, unknown>),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await callTool(api, request.params.name, request.params.arguments, { signal: extra.signal });
    } catch (e) {
      if (e instanceof InvalidToolCall) {
        throw rpcError(ErrorCode.InvalidParams, e.message);
      }
      if (extra.signal.aborted) {
        throw e;
      }
      throw rpcError(ErrorCode.InternalError, 'Error while executing tool');
    }
  });

  return mcp;
}

export interface StdioOptions {
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Serves the tools over STDIO (for Claude Code, Claude Desktop, the MCP Inspector). Nothing else may
 * write to stdout while it runs; log to stderr. Resolves with the server once connected.
 */
export async function serveStdio(api: ServiceApi, options: StdioOptions = {}): Promise<McpServer> {
  const server = createMcpServer(api);
  await server.connect(new StdioServerTransport(options.stdin, options.stdout));

  return server;
}

export interface McpHttpHandlerOptions {
  /** Sessions idle longer than this are closed; default 3600000 (1 hour). */
  sessionIdleMs?: number;
  /** At most this many open sessions; the least recently used is closed first. Default 1000. */
  maxSessions?: number;
  /** Largest POST body in bytes; default 2 MiB. */
  maxBodyBytes?: number;
}

/**
 * Streamable HTTP for `startServer({ mcp })` / `createRequestListener({ mcp })`, which guard /mcp like
 * /v1 (host names, origin, JSON, bearer token or local peer). Stateful: `initialize` opens a session
 * (`Mcp-Session-Id`), each session has its own server; answers are JSON, not SSE.
 */
export function createMcpHttpHandler(api: ServiceApi, options: McpHttpHandlerOptions = {}): McpHttpHandler {
  const { sessionIdleMs = 3_600_000, maxSessions = 1000, maxBodyBytes = 2 * 1024 * 1024 } = options;
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer; usedAt: number }>();

  const closeSession = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.server.close();
  };
  const sweep = async (): Promise<void> => {
    const now = Date.now();
    const doomed = new Set([...sessions].filter(([, s]) => now - s.usedAt > sessionIdleMs).map(([id]) => id));
    // Map order is insertion order and used sessions are re-inserted: the first is the least recently used.
    for (const id of sessions.keys()) {
      if (sessions.size - doomed.size < maxSessions) {
        break;
      }
      doomed.add(id);
    }
    await Promise.all([...doomed].map(closeSession));
  };

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const header = req.headers['mcp-session-id'];
      const id = Array.isArray(header) ? header[0] : header;
      const session = id === undefined ? undefined : sessions.get(id);
      if (session !== undefined && id !== undefined) {
        sessions.delete(id);
        session.usedAt = Date.now();
        sessions.set(id, session);
        await session.transport.handleRequest(req, res);

        return;
      }
      if (id !== undefined || req.method !== 'POST') {
        sendRpcError(
          res,
          id === undefined ? 400 : 404,
          id === undefined ? 'Bad Request: No valid session ID provided' : 'Session not found',
        );

        return;
      }

      const body = await readJson(req, maxBodyBytes);
      if (
        body === undefined ||
        !(Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body))
      ) {
        sendRpcError(res, 400, 'Bad Request: No valid session ID provided');

        return;
      }
      await sweep();
      const server = createMcpServer(api);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        maxRequestBodySize: maxBodyBytes,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { transport, server, usedAt: Date.now() });
        },
        onsessionclosed: (sessionId) => {
          sessions.delete(sessionId);
        },
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    },

    async close(): Promise<void> {
      await Promise.all([...sessions.keys()].map(closeSession));
    },
  };
}

/**
 * A JSON-RPC error with exactly this message (McpError would prefix "MCP error <code>: " on the wire).
 */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      return undefined;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function sendRpcError(res: ServerResponse, status: number, message: string): void {
  const json = JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}
