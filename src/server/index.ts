/**
 * @waswrongassembled/pii-shield/server: pii-shield as an HTTP service (/v1, docs/openapi.yaml), on plain
 * `node:http`, with the same endpoints, JSON shapes, status codes, messages and request checks as the
 * PHP service. The `pii-shield` CLI (`pii-shield serve`, `pii-shield mcp`) is built on it.
 */
export {
  createRequestListener,
  DEFAULT_MAX_BODY_BYTES,
  MCP_BROWSER_ORIGINS,
  type McpHttpHandler,
  openapiDocument,
  type PiiShieldServer,
  type RequestListenerOptions,
  type ServerOptions,
  startServer,
} from './http-server.js';
export { type JsonBody, parseJsonBody, type ParsedBody } from '../service/json-body.js';
export { defaultGateway, localPeerMatcher, splitList } from '../service/local-peer.js';
export {
  ServiceApi,
  type ServiceApiOptions,
  type ServiceOperation,
  type ServiceRequest,
  type ServiceResponse,
} from '../service/service-api.js';
