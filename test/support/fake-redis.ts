import type { RedisClient } from '../../src/vault-redis/index.js';

/** The subset of ioredis that RedisVaultStorage uses, with Redis' expiry semantics. */
export class FakeRedis implements RedisClient {
  readonly entries = new Map<string, { value: Buffer; expiresAt: number }>();
  readonly calls: unknown[][] = [];
  now = 0;

  set(key: string, value: Buffer, secondsToken: 'EX', seconds: number): Promise<'OK'> {
    this.calls.push(['set', key, secondsToken, seconds]);
    this.entries.set(key, { value: Buffer.from(value), expiresAt: this.now + seconds * 1000 });

    return Promise.resolve('OK');
  }

  getBuffer(key: string): Promise<Buffer | null> {
    this.calls.push(['getBuffer', key]);
    const entry = this.entries.get(key);

    return Promise.resolve(entry === undefined || entry.expiresAt <= this.now ? null : Buffer.from(entry.value));
  }

  del(key: string): Promise<number> {
    this.calls.push(['del', key]);

    return Promise.resolve(this.entries.delete(key) ? 1 : 0);
  }
}
