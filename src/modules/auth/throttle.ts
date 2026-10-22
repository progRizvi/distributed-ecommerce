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

export class RedisLoginThrottle implements LoginThrottle {
  private readonly maxFailures: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly store: CounterStore,
    options: ThrottleOptions = {},
  ) {
    this.maxFailures = options.maxFailures ?? 5;
    this.windowSeconds = options.windowSeconds ?? 15 * 60;
  }

  // Hash the key so Redis never holds a plain email address.
  private redisKey(key: string): string {
    return `auth:login-fail:${createHash('sha256').update(key).digest('hex')}`;
  }

  async isBlocked(key: string): Promise<boolean> {
    return Number((await this.store.get(this.redisKey(key))) ?? 0) >= this.maxFailures;
  }

  async recordFailure(key: string): Promise<void> {
    const redisKey = this.redisKey(key);
    const count = await this.store.incr(redisKey);
    if (count === 1) await this.store.expire(redisKey, this.windowSeconds);
  }

  async reset(key: string): Promise<void> {
    await this.store.del(this.redisKey(key));
  }
}
