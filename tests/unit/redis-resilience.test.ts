import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { FailOpenLoginThrottle, type LoginThrottle } from '../../src/modules/auth/throttle.js';
import { resilientRedisOptions } from '../../src/shared/redis/retry-strategy.js';
import { stubTestEnv } from '../helpers/env.js';
import { createFakeThrottle } from '../helpers/fakes.js';

// Port 1 = nothing listens there, so this is a Redis that is down. No real Redis is touched.
const clients: Redis[] = [];
function deadRedis(): Redis {
  const client = new Redis('redis://127.0.0.1:1', { ...resilientRedisOptions({ baseMs: 20, maxMs: 40 }), lazyConnect: true });
  client.on('error', () => {}); // ioredis reports every failed reconnect; we only care about the commands
  clients.push(client);
  return client;
}
afterEach(() => {
  while (clients.length > 0) clients.pop()?.disconnect();
});

describe('Redis client settings', () => {
  it('a command fails FAST when Redis is down (no waiting for the reconnect loop)', async () => {
    const client = deadRedis();
    const started = Date.now();
    await expect(client.get('anything')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps failing fast on later commands too', async () => {
    const client = deadRedis();
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) await expect(client.incr('k')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('global rate limit when Redis is down', () => {
  it('lets requests through (skipOnError) instead of returning an error', async () => {
    stubTestEnv();
    const { setupRateLimit } = await import('../../src/bootstrap/rate-limit.js');
    const app = Fastify();
    await setupRateLimit(app, deadRedis());
    app.get('/ping', async () => ({ ok: true }));
    await app.ready();

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/ping' });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});

describe('FailOpenLoginThrottle', () => {
  const broken = (): LoginThrottle => ({
    isBlocked: () => Promise.reject(new Error('redis down')),
    recordFailure: () => Promise.reject(new Error('redis down')),
    reset: () => Promise.reject(new Error('redis down')),
  });

  it('when Redis fails: not blocked, nothing throws, and the errors are reported', async () => {
    const errors: unknown[] = [];
    const throttle = new FailOpenLoginThrottle(broken(), (e) => errors.push(e));

    expect(await throttle.isBlocked('k')).toBe(false);
    await expect(throttle.recordFailure('k')).resolves.toBeUndefined();
    await expect(throttle.reset('k')).resolves.toBeUndefined();
    expect(errors).toHaveLength(3);
  });

  it('when Redis works: behaves exactly like the real throttle', async () => {
    const throttle = new FailOpenLoginThrottle(createFakeThrottle(2));
    await throttle.recordFailure('k');
    expect(await throttle.isBlocked('k')).toBe(false);
    await throttle.recordFailure('k');
    expect(await throttle.isBlocked('k')).toBe(true);
    await throttle.reset('k');
    expect(await throttle.isBlocked('k')).toBe(false);
  });

  it('works with the real Redis throttle on a dead Redis', async () => {
    const { RedisLoginThrottle } = await import('../../src/modules/auth/throttle.js');
    const errors: unknown[] = [];
    const throttle = new FailOpenLoginThrottle(new RedisLoginThrottle(deadRedis()), (e) => errors.push(e));
    const started = Date.now();

    expect(await throttle.isBlocked('k')).toBe(false);
    await throttle.recordFailure('k');
    await throttle.reset('k');

    expect(errors).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
