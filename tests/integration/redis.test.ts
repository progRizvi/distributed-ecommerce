import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisTokenRevocations } from '../../src/modules/auth/revocations.js';
import { RedisLoginThrottle } from '../../src/modules/auth/throttle.js';
import { BloomFilter } from '../../src/shared/bloom/bloom-filter.js';
import { RedisBitStore } from '../../src/shared/bloom/redis-bit-store.js';

// Our Redis code against a real Redis. Skipped unless TEST_REDIS_URL is set:
//   PowerShell:  $env:TEST_REDIS_URL="redis://localhost:6379"; pnpm test
// All keys use random ids. Keys that would live forever get a 60 second expiry here. Nothing is removed.
const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)('our Redis code on a real Redis', () => {
  const redis = new Redis(url!);
  afterAll(async () => {
    await redis.quit();
  });

  it('Bloom filter: added items are found, strangers are (almost always) not', async () => {
    const filter = new BloomFilter(new RedisBitStore(redis), { name: `it-${randomUUID()}`, expectedItems: 1_000, falsePositiveRate: 0.01 });
    await redis.expire(filter.key, 60); // key does not exist yet: expire is a no-op, so set it again after the first add
    const emails = Array.from({ length: 300 }, (_, i) => `user${i}@example.test`);

    await filter.addMany(emails);
    await redis.expire(filter.key, 60);

    for (const email of emails) expect(await filter.mightContain(email)).toBe(true);
    let falsePositives = 0;
    for (let i = 0; i < 500; i += 1) if (await filter.mightContain(`stranger${i}@other.test`)) falsePositives += 1;
    expect(falsePositives / 500).toBeLessThan(0.03);
    expect(await redis.ttl(filter.key)).toBeGreaterThan(0);
  });

  it('Bloom filter: rebuild swap (build next to the live key, then rename)', async () => {
    const store = new RedisBitStore(redis);
    const options = { name: `it-${randomUUID()}`, expectedItems: 1_000, falsePositiveRate: 0.01 };
    const live = new BloomFilter(store, options);
    const building = new BloomFilter(store, options, ':building');

    await building.addMany(['a@example.test']);
    await redis.expire(building.key, 60);
    expect(await live.mightContain('a@example.test')).toBe(false); // not live yet

    await store.rename(building.key, live.key);

    expect(await live.mightContain('a@example.test')).toBe(true);
    expect(await redis.exists(building.key)).toBe(0);
  });

  it('Token revocation: session mark, user mark and the TTL', async () => {
    const revocations = new RedisTokenRevocations(redis, () => 1_800_000_000 * 1000);
    const sid = randomUUID();
    const userId = randomUUID();

    expect(await revocations.isRevoked({ sub: userId, sid, iat: 1_799_999_000 })).toBe(false);

    await revocations.revokeSession(sid, 60);
    expect(await revocations.isRevoked({ sub: userId, sid, iat: 1_799_999_000 })).toBe(true);
    expect(await redis.ttl(`auth:revoked-sid:${sid}`)).toBeGreaterThan(0);

    await revocations.revokeUser(userId, 60);
    expect(await revocations.isRevoked({ sub: userId, sid: randomUUID(), iat: 1_799_999_000 })).toBe(true); // older token
    expect(await revocations.isRevoked({ sub: userId, sid: randomUUID(), iat: 1_800_000_000 })).toBe(false); // new login
    expect(await redis.ttl(`auth:revoked-after:${userId}`)).toBeGreaterThan(0);
  });

  it('Login throttle: blocks after the limit, sets a TTL, resets', async () => {
    const throttle = new RedisLoginThrottle(redis, { maxFailures: 3, windowSeconds: 60 });
    const key = `it-${randomUUID()}:user@example.test`;

    expect(await throttle.isBlocked(key)).toBe(false);
    await throttle.recordFailure(key);
    await throttle.recordFailure(key);
    expect(await throttle.isBlocked(key)).toBe(false);
    await throttle.recordFailure(key);
    expect(await throttle.isBlocked(key)).toBe(true);

    await throttle.reset(key);
    expect(await throttle.isBlocked(key)).toBe(false);
  });
});
