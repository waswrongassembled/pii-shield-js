/**
 * The Redis client and the Postgres pool of the service's configuration, opened on first use and shared
 * by both stores. Used by serviceFromEnv() and by checkServiceConfig({ connect: true }).
 */
import type { PostgresQuery } from '../postgres/index.js';
import { ConfigError, type EnvGetter, readDatabaseUrl, readRedisUrl } from './env.js';

export interface RedisLike {
  getBuffer(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer | string, ...args: unknown[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  ping(): Promise<unknown>;
  quit(): Promise<unknown>;
  connect(): Promise<unknown>;
  disconnect(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** The part of a `pg` Pool the service uses. */
interface PoolLike {
  query: PostgresQuery;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(): Promise<void>;
}

export interface Connections {
  redis(): Promise<RedisLike>;
  postgres(): Promise<PostgresQuery>;
  /** An error message for the operator, without the database or Redis URL or their passwords. */
  safeMessage(error: unknown): string;
  /** Closes what was opened. */
  close(): Promise<void>;
  /** Closes what was opened and ignores errors (after a failure). */
  closeQuietly(): Promise<void>;
}

export interface ConnectionOptions {
  /** Errors of idle pool connections (a database restart must not crash the process). */
  onPoolError: (error: Error) => void;
  /** Fail fast instead of reconnecting forever (for a one-off check). */
  failFast?: boolean;
}

export function connections(get: EnvGetter, options: ConnectionOptions): Connections {
  let redis: RedisLike | undefined;
  let pool: PoolLike | undefined;
  // Both URLs can hold a password: error messages never quote them.
  const secretUrls = [
    [get('PII_SERVICE_DATABASE_URL'), 'PII_SERVICE_DATABASE_URL'],
    [get('PII_SERVICE_REDIS_URL') ?? get('PII_DEMO_REDIS_URL'), 'PII_SERVICE_REDIS_URL'],
  ] as const;

  return {
    redis: async () => {
      const url = readRedisUrl(get);
      if (redis === undefined) {
        type RedisConstructor = new (url: string, options?: Record<string, unknown>) => RedisLike;
        let Redis: RedisConstructor;
        try {
          ({ Redis } = (await import('ioredis')) as unknown as { Redis: RedisConstructor });
        } catch {
          throw new ConfigError('The redis store needs the package "ioredis" (npm install ioredis).');
        }
        if (options.failFast === true) {
          const client = new Redis(url, {
            lazyConnect: true,
            maxRetriesPerRequest: 0,
            connectTimeout: 5000,
            retryStrategy: () => null,
          });
          // connect() rejects with the error; without a listener ioredis also prints it.
          let cause: unknown;
          client.on('error', (e) => {
            cause ??= e;
          });
          try {
            await client.connect();
          } catch (e) {
            client.disconnect();
            // connect() only says "Connection is closed."; the error event has the reason (ECONNREFUSED).
            throw cause ?? e;
          }
          redis = client;
        } else {
          redis = new Redis(url);
        }
      }

      return redis;
    },
    postgres: async () => {
      const url = readDatabaseUrl(get);
      if (pool === undefined) {
        type PoolConstructor = new (config: { connectionString: string; connectionTimeoutMillis?: number }) => PoolLike;
        let Pool: PoolConstructor | undefined;
        try {
          const pg = (await import('pg')) as unknown as {
            Pool?: PoolConstructor;
            default?: { Pool?: PoolConstructor };
          };
          Pool = pg.Pool ?? pg.default?.Pool;
        } catch {
          // reported below
        }
        if (Pool === undefined) {
          throw new ConfigError('The postgres store needs the package "pg" (npm install pg).');
        }
        pool = new Pool({
          connectionString: url,
          ...(options.failFast === true ? { connectionTimeoutMillis: 5000 } : {}),
        });
        pool.on('error', options.onPoolError);
      }
      const connected = pool;

      return (text, params) => connected.query(text, params);
    },
    safeMessage: (e) => {
      let message = e instanceof Error ? e.message : String(e);
      for (const [url, name] of secretUrls) {
        if (url === undefined) {
          continue;
        }
        message = message.split(url).join(`<${name}>`);
        const password = URL.canParse(url) ? decodeURIComponent(new URL(url).password) : '';
        if (password !== '') {
          message = message.split(password).join('***');
        }
      }

      return message;
    },
    close: async () => {
      await Promise.all([redis?.quit(), pool?.end()]);
    },
    closeQuietly: async () => {
      if (options.failFast === true) {
        redis?.disconnect();
      }
      await Promise.all([
        options.failFast === true ? undefined : redis?.quit().catch(() => undefined),
        pool?.end().catch(() => undefined),
      ]);
    },
  };
}
