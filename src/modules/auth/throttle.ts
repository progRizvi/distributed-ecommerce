import { createHash } from 'node:crypto';

// Blocks brute force on one account from one IP, on top of the plain per-IP rate limit.
export interface LoginThrottle {
  isBlocked(key: string): Promise<boolean>;
  recordFailure(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

// The parts of ioredis we use (keeps this easy to fake in tests).
export interface CounterStore {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface ThrottleOptions {
  maxFailures?: number;
  windowSeconds?: number;
}

export function createRedisLoginThrottle(store: CounterStore, options: ThrottleOptions = {}): LoginThrottle {
  const maxFailures = options.maxFailures ?? 5;
  const windowSeconds = options.windowSeconds ?? 15 * 60;
  // Hash the key so Redis never holds a plain email address.
  const redisKey = (key: string) => `auth:login-fail:${createHash('sha256').update(key).digest('hex')}`;

  return {
    async isBlocked(key) {
      return Number((await store.get(redisKey(key))) ?? 0) >= maxFailures;
    },
    async recordFailure(key) {
      const count = await store.incr(redisKey(key));
      if (count === 1) await store.expire(redisKey(key), windowSeconds);
    },
    async reset(key) {
      await store.del(redisKey(key));
    },
  };
}
