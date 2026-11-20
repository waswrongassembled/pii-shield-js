import { createHash } from 'node:crypto';

import type { Cluster, Redis } from 'ioredis';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { EncryptedVault, generateVaultKey } from '../src/index.js';
import { type RedisClient, RedisVaultStorage } from '../src/vault-redis/index.js';

/** The subset of ioredis that RedisVaultStorage uses, with Redis' expiry semantics. */
class FakeRedis implements RedisClient {
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

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

describe('RedisVaultStorage', () => {
  it('accepts an ioredis client or cluster', () => {
    expectTypeOf<Redis>().toExtend<RedisClient>();
    expectTypeOf<Cluster>().toExtend<RedisClient>();
  });

  it('puts, gets and removes binary payloads under a hashed, prefixed key', async () => {
    const client = new FakeRedis();
    const storage = new RedisVaultStorage({ client });
    const payload = Uint8Array.of(0, 98, 105, 110, 0xff);
    const key = `pii_shield_vault.${sha256('id-1')}`;

    await storage.put('id-1', payload, 60);
    const fetched = await storage.get('id-1');
    await storage.remove('id-1');

    expect(fetched).toEqual(payload);
    expect(fetched).toBeInstanceOf(Uint8Array);
    expect(await storage.get('id-1')).toBeNull();
    expect(client.calls).toEqual([
      ['set', key, 'EX', 60],
      ['getBuffer', key],
      ['del', key],
      ['getBuffer', key],
    ]);
  });

  it('uses a custom prefix', async () => {
    const client = new FakeRedis();

    await new RedisVaultStorage({ client, prefix: 'app:vault:' }).put('id-1', Uint8Array.of(1), 60);

    expect([...client.entries.keys()]).toEqual([`app:vault:${sha256('id-1')}`]);
  });

  it('writes only the bytes of a payload view, not its whole buffer', async () => {
    const client = new FakeRedis();
    const buffer = Uint8Array.of(9, 1, 2, 3, 9);

    await new RedisVaultStorage({ client }).put('id-1', buffer.subarray(1, 4), 60);

    expect([...client.entries.values()][0]?.value).toEqual(Buffer.from([1, 2, 3]));
  });

  it('lets Redis expire entries', async () => {
    const client = new FakeRedis();
    const storage = new RedisVaultStorage({ client });
    await storage.put('id-1', Uint8Array.of(1), 60);

    client.now += 61_000;

    expect(await storage.get('id-1')).toBeNull();
  });

  it('treats ids with reserved characters safely', async () => {
    const storage = new RedisVaultStorage({ client: new FakeRedis() });
    await storage.put('a/b:c@d*', Uint8Array.of(1), 60);

    expect(await storage.get('a/b:c@d*')).toEqual(Uint8Array.of(1));
    expect(await storage.get('a_b_c_d_')).toBeNull();
  });

  it.each([0, -1, 1.5])('rejects TTL %s', async (ttl) => {
    await expect(new RedisVaultStorage({ client: new FakeRedis() }).put('id-1', Uint8Array.of(1), ttl)).rejects.toThrow(
      /The TTL must be/,
    );
  });

  it('works behind EncryptedVault', async () => {
    const client = new FakeRedis();
    const vault = new EncryptedVault({ storage: new RedisVaultStorage({ client }), key: generateVaultKey() });

    await vault.store('id-1', { '⟦PERSON_1⟧': 'Maria Musterfrau' }, 60);

    expect(await vault.fetch('id-1')).toEqual({ '⟦PERSON_1⟧': 'Maria Musterfrau' });
    expect(Buffer.concat([...client.entries.values()].map((e) => e.value)).includes('Maria')).toBe(false);
  });
});
