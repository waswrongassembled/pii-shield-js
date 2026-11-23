import { createHash, timingSafeEqual } from 'node:crypto';

import { type AsyncDetector, type DetectOptions, type Detector, isAsyncDetector } from '../detector.js';
import { EmailDetector } from '../detectors/email.js';
import { KnownValuesDetector } from '../detectors/known-values.js';
import { PhoneDetector } from '../detectors/phone.js';
import type { Entity } from '../entity.js';
import { defaultDetectors } from '../entity-extractor.js';
import { type EntityType, isEntityType } from '../entity-type.js';
import { DetectionError, LearningError, PiiShieldError, VaultError } from '../errors.js';
import { codePointLength } from '../internal/pcre.js';
import type { EntityLearner } from '../learning/entity-learner.js';
import { PiiMasker } from '../pii-masker.js';
import { PiiShield } from '../pii-shield.js';
import { assertTtl, type Vault } from '../vault/vault.js';
import type { JsonBody } from './json-body.js';
import { localPeerMatcher } from './local-peer.js';

/** The operations shared by the HTTP API and the MCP tools. */
export type ServiceOperation = 'redact' | 'restore' | 'mask' | 'learn' | 'entities';

/** Status code and JSON body (null for 204) of one API call. */
export interface ServiceResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>> | null;
}

export interface ServiceRequest {
  readonly method: string;
  /** Decoded path, e.g. "/v1/redact". */
  readonly path: string;
  /** Decoded JSON body (POST), else null. */
  readonly body: JsonBody | null;
  readonly authorization?: string | undefined;
  /** The peer's IP address (socket), for the localhost rule. */
  readonly remoteAddress?: string | undefined;
  /** Aborts model-based detection, e.g. when the client disconnects. */
  readonly signal?: AbortSignal | undefined;
}

export interface ServiceApiOptions {
  /** Stores the placeholder mapping between redact and restore; use an EncryptedVault. */
  vault: Vault;
  /** Learned types: used by every detection, managed by /v1/learn and /v1/entities. */
  learner: EntityLearner;
  /**
   * Creates the detector for `"detection": "model" | "both"` (called per request), e.g. a ModelDetector.
   * Without it those requests get 422. Which model detects is server configuration, never request input.
   */
  modelDetector?: (() => AsyncDetector | Detector) | undefined;
  /** Bearer token (PII_SERVICE_TOKEN). Without one, only local peers are answered. */
  token?: string | undefined;
  /** Seconds a mapping lives in the vault; default 900 (15 minutes). */
  vaultTtl?: number;
  /** Service mode (PII_SERVICE_ONLY=1): never trust local peers; without a token every request gets 503. */
  requireToken?: boolean;
  /** Which peers count as this machine; default 127.0.0.1 and ::1, see localPeerMatcher(). */
  isLocalPeer?: (address: string | undefined) => boolean;
  /**
   * Called with errors that end up as a generic 500/502 response (never with the request text). The
   * default does nothing; a model provider's error (`cause` of a DetectionError) may quote the text.
   */
  onError?: (error: unknown) => void;
}

const ROUTES: Readonly<Record<string, ServiceOperation>> = {
  '/v1/redact': 'redact',
  '/v1/restore': 'restore',
  '/v1/mask': 'mask',
  '/v1/learn': 'learn',
  '/v1/entities': 'entities',
};
const ENTITY_PATH = /^\/v1\/entities\/([A-Z][A-Z0-9_]{1,39})$/;
const VAULT_PATH = /^\/v1\/vault\/([0-9a-f]{32})$/;
const PLACEHOLDER_TYPE = /^⟦(.+)_\p{Nd}+⟧$/u;

/** A client error (400): the request is malformed. */
class BadRequest extends Error {}

/**
 * The versioned HTTP API (/v1) of pii-shield as a service, framework-free: routing, authentication and
 * the operations. Port of PHP's `ServiceApi`, same JSON shapes, status codes and messages
 * (docs/openapi.yaml). `createServer()` (HTTP) and the MCP tools use it.
 *
 * The placeholder mapping never leaves the service: redact returns placeholders and a vault id, restore
 * resolves them. Errors never contain personal data; model errors are generic (details go to onError).
 */
export class ServiceApi {
  static readonly MAX_TEXT_LENGTH = 100_000;
  static readonly DEFAULT_VAULT_TTL = 900;

  readonly #vault: Vault;
  readonly #learner: EntityLearner;
  readonly #modelDetector: (() => AsyncDetector | Detector) | undefined;
  readonly #token: string | undefined;
  readonly #vaultTtl: number;
  readonly #requireToken: boolean;
  readonly #isLocalPeer: (address: string | undefined) => boolean;
  readonly #onError: (error: unknown) => void;

  constructor(options: ServiceApiOptions) {
    this.#vault = options.vault;
    this.#learner = options.learner;
    this.#modelDetector = options.modelDetector;
    this.#token = options.token === '' ? undefined : options.token;
    this.#vaultTtl = options.vaultTtl ?? ServiceApi.DEFAULT_VAULT_TTL;
    this.#requireToken = options.requireToken ?? false;
    this.#isLocalPeer = options.isLocalPeer ?? localPeerMatcher();
    this.#onError =
      options.onError ??
      (() => {
        // silent by default
      });
    assertTtl(this.#vaultTtl, 'The vault TTL must be positive.');
  }

  /** Whether `"detection": "model" | "both"` is available (reported by /v1/health). */
  get modelDetection(): boolean {
    return this.#modelDetector !== undefined;
  }

  /** Routes, authenticates and runs one request. */
  async handle(request: ServiceRequest): Promise<ServiceResponse> {
    const { method, path } = request;
    if (path === '/v1/health') {
      return method === 'GET' ? ok({ status: 'ok', modelDetection: this.modelDetection }) : error(405, 'Use GET.');
    }
    const denied = this.checkAccess(request.authorization, request.remoteAddress);
    if (denied !== null) {
      return denied;
    }

    const operation = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (operation !== undefined) {
      const allowed = operation === 'entities' ? 'GET' : 'POST';

      return method === allowed
        ? this.operation(operation, request.body ?? {}, { signal: request.signal })
        : error(405, `Use ${allowed}.`);
    }
    const entity = ENTITY_PATH.exec(path);
    if (entity?.[1] !== undefined) {
      return method === 'DELETE' ? this.#guarded(() => this.#forgetType(entity[1] ?? '')) : error(405, 'Use DELETE.');
    }
    const vault = VAULT_PATH.exec(path);
    if (vault?.[1] !== undefined) {
      if (method !== 'DELETE') {
        return error(405, 'Use DELETE.');
      }

      return this.#guarded(async () => {
        await this.#vault.delete(vault[1] ?? '');

        return { status: 204, body: null };
      });
    }

    return error(404, 'Not found.');
  }

  /**
   * The access rule of /v1 and /mcp: the bearer token if one is configured, otherwise local peers only;
   * in service mode a token is required. Returns the error response, or null when access is granted.
   */
  checkAccess(authorization: string | undefined, remoteAddress: string | undefined): ServiceResponse | null {
    if (this.#token === undefined) {
      if (this.#requireToken) {
        return error(503, 'Set PII_SERVICE_TOKEN to use this service.');
      }

      return this.#isLocalPeer(remoteAddress) ? null : error(401, 'Missing or invalid bearer token.');
    }

    return authorization !== undefined && constantTimeEquals(`Bearer ${this.#token}`, authorization)
      ? null
      : error(401, 'Missing or invalid bearer token.');
  }

  /**
   * One operation without routing or authentication (the caller has authenticated), shared by the
   * HTTP API and the MCP tools.
   */
  operation(operation: ServiceOperation, body: JsonBody, options: DetectOptions = {}): Promise<ServiceResponse> {
    return this.#guarded(() => {
      switch (operation) {
        case 'redact':
          return this.#redact(body, options);
        case 'restore':
          return this.#restore(body);
        case 'mask':
          return this.#mask(body, options);
        case 'learn':
          return this.#learn(body);
        case 'entities':
          return this.#entities();
      }
    });
  }

  async #guarded(run: () => Promise<ServiceResponse>): Promise<ServiceResponse> {
    try {
      return await run();
    } catch (e) {
      if (e instanceof BadRequest) {
        return error(400, e.message);
      }
      if (e instanceof LearningError) {
        return error(422, e.message);
      }
      if (e instanceof DetectionError) {
        this.#onError(e);

        // Details (model name, URLs, provider errors) stay on the server.
        return error(502, 'Model-based detection failed.');
      }
      if (e instanceof PiiShieldError) {
        this.#onError(e);

        return error(500, 'Detection failed.');
      }
      throw e;
    }
  }

  async #redact(body: JsonBody, options: DetectOptions): Promise<ServiceResponse> {
    const detectors = await this.#detectors(body);
    const allowlist = strings(body, 'allowlist');
    detectors.push(...knownValues(body));
    const text = textOf(body);
    const shield = new PiiShield({ detectors, vault: this.#vault, vaultTtl: this.#vaultTtl, allowlist });
    const redaction = await shield.redactToVault(text, options);

    return ok({
      text: redaction.redactedText,
      vaultId: redaction.vaultId,
      expiresIn: this.#vaultTtl,
      placeholders: Object.keys(redaction.mapping).map((placeholder) => ({
        placeholder,
        type: PLACEHOLDER_TYPE.exec(placeholder)?.[1] ?? placeholder,
      })),
    });
  }

  async #restore(body: JsonBody): Promise<ServiceResponse> {
    const vaultId = field(body, 'vaultId');
    const text = textOf(body);
    let restored;
    try {
      restored = await new PiiShield({ detectors: [], vault: this.#vault }).restoreFromVault(
        text,
        typeof vaultId === 'string' ? vaultId : '',
      );
    } catch (e) {
      if (e instanceof VaultError) {
        return error(404, 'Unknown or expired vault id. Redact the text again.');
      }
      throw e;
    }

    return ok({
      text: restored.text,
      unknownPlaceholders: restored.unknownPlaceholders,
      unusedPlaceholders: restored.unusedPlaceholders,
    });
  }

  async #mask(body: JsonBody, options: DetectOptions): Promise<ServiceResponse> {
    const detectors = await this.#detectors(body);
    const allowlist = strings(body, 'allowlist');
    detectors.push(...knownValues(body));
    const text = textOf(body);

    return ok({ text: await new PiiMasker({ detectors, allowlist }).maskAsync(text, options) });
  }

  async #learn(body: JsonBody): Promise<ServiceResponse> {
    const name = field(body, 'name');
    const description = field(body, 'description');
    const pattern = field(body, 'pattern');
    const init = {
      name: typeof name === 'string' ? name : '',
      description: typeof description === 'string' ? description : '',
      examples: strings(body, 'examples'),
      counterExamples: strings(body, 'counterExamples'),
      pattern: typeof pattern === 'string' ? pattern : null,
    };
    const dryRun = field(body, 'dryRun') === true;
    const result = dryRun ? this.#learner.preview(init) : await this.#learner.learn(init);

    return { status: dryRun ? 200 : 201, body: { type: result.type, note: result.note, saved: !dryRun } };
  }

  async #entities(): Promise<ServiceResponse> {
    return ok({ types: await this.#learner.types() });
  }

  async #forgetType(name: string): Promise<ServiceResponse> {
    if (!(await this.#learner.types()).some((t) => t.name === name)) {
      return error(404, `No learned type "${name}".`);
    }
    await this.#learner.forget(name);

    return { status: 204, body: null };
  }

  /** Built-in patterns, learned types and, on request, the configured model. */
  async #detectors(body: JsonBody): Promise<(Detector | AsyncDetector)[]> {
    const detection = field(body, 'detection') ?? 'regex';
    if (detection !== 'regex' && detection !== 'model' && detection !== 'both') {
      throw new BadRequest('"detection" must be "regex", "model" or "both".');
    }

    // Other processes may have learned types since (PHP reads the store at every detection).
    await this.#learner.refresh();
    const detectors: (Detector | AsyncDetector)[] = [this.#learner.detector()];
    if (detection !== 'model') {
      const keepAuthorityContacts = field(body, 'keepAuthorityContacts') !== false;
      for (const detector of defaultDetectors()) {
        detectors.push(
          detector instanceof EmailDetector
            ? new EmailDetector({ keepAuthorityContacts })
            : detector instanceof PhoneDetector
              ? new PhoneDetector({ keepAuthorityContacts })
              : detector,
        );
      }
    }
    if (detection !== 'regex') {
      if (this.#modelDetector === undefined) {
        throw new LearningError('Model-based detection is not configured on this server.');
      }
      detectors.push(this.#modelDetector());
    }

    if (field(body, 'types') === undefined) {
      return detectors;
    }
    const types = new Set<string>();
    for (const type of strings(body, 'types')) {
      if (!isEntityType(type)) {
        throw new BadRequest(`Unknown type "${type}".`);
      }
      types.add(type);
    }

    return detectors.map((d) => onlyTypes(d, types));
  }
}

/**
 * Keeps only findings of the given built-in types. Learned types have the type OTHER, so like PHP's
 * RequestScopedDetector this drops them unless OTHER is listed.
 */
function onlyTypes(detector: Detector | AsyncDetector, types: ReadonlySet<string>): Detector | AsyncDetector {
  const keep = (entities: readonly Entity[]): Entity[] => entities.filter((e) => types.has(e.type));
  if (isAsyncDetector(detector)) {
    return {
      async: true,
      detect: async (text: string, options?: DetectOptions) => keep(await detector.detect(text, options)),
    };
  }

  return { detect: (text: string) => keep(detector.detect(text)) };
}

/** A body field; PHP's `$body[$key] ?? null` (null counts as missing). Own properties only. */
function field(body: JsonBody, key: string): unknown {
  return Object.hasOwn(body, key) ? (body[key] ?? undefined) : undefined;
}

function textOf(body: JsonBody): string {
  const text = field(body, 'text');
  if (typeof text !== 'string') {
    throw new BadRequest('"text" must be a string.');
  }
  if (codePointLength(text) > ServiceApi.MAX_TEXT_LENGTH) {
    throw new BadRequest(`"text" is longer than ${String(ServiceApi.MAX_TEXT_LENGTH)} characters.`);
  }

  return text;
}

/** A list of strings; missing = empty. A JSON object counts as a list of its values (a PHP array). */
function strings(body: JsonBody, key: string): string[] {
  const value = field(body, key) ?? [];
  const items = Array.isArray(value) ? (value as unknown[]) : typeof value === 'object' ? Object.values(value) : [null];
  if (!items.every((item): item is string => typeof item === 'string')) {
    throw new BadRequest(`"${key}" must be a list of strings.`);
  }

  return items;
}

/**
 * The detector for `knownValues` ([{ value, type }]), or none. Added after the `types` filter, so known
 * values always apply. Messages never contain a value.
 */
function knownValues(body: JsonBody): KnownValuesDetector[] {
  const list = field(body, 'knownValues');
  if (list === undefined) {
    return [];
  }
  if (!Array.isArray(list)) {
    throw new BadRequest('"knownValues" must be a list of {"value", "type"} objects.');
  }
  try {
    return [new KnownValuesDetector(list as { value: string; type: EntityType }[])];
  } catch (e) {
    if (e instanceof TypeError) {
      throw new BadRequest(`"knownValues": ${e.message}`);
    }
    throw e;
  }
}

function constantTimeEquals(expected: string, actual: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

  return timingSafeEqual(digest(expected), digest(actual));
}

function ok(body: Record<string, unknown>): ServiceResponse {
  return { status: 200, body };
}

function error(status: number, message: string): ServiceResponse {
  return { status, body: { error: message } };
}
