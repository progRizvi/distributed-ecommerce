export interface RetryOptions {
  baseMs?: number;
  maxMs?: number;
  /** Random number in [0, 1). Replace it in tests. */
  random?: () => number;
}

// For ioredis `retryStrategy`: how long to wait before reconnecting.
// Exponential backoff (100, 200, 400 ... ms, up to maxMs) with "equal jitter": the wait is
// somewhere between half and the full delay. Without the random part, every app instance would
// reconnect at the same moment after a Redis restart and hit it all at once.
export function createRedisRetryStrategy({ baseMs = 100, maxMs = 5_000, random = Math.random }: RetryOptions = {}) {
  return (attempt: number): number => {
    const delay = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 16));
    return Math.round(delay / 2 + (random() * delay) / 2);
  };
}

// Settings for the Redis client the web server shares (rate limit, revoke marks, Bloom filter, login throttle).
// Goal: when Redis is down, a request finds out FAST and the code can carry on without it.
export function resilientRedisOptions(options: RetryOptions & { commandTimeoutMs?: number } = {}) {
  return {
    // Do not queue commands while disconnected. Without this a request waits for the reconnect loop.
    enableOfflineQueue: false,
    // A command that was sent but never answered (Redis frozen) gives up after this long.
    commandTimeout: options.commandTimeoutMs ?? 2_000,
    maxRetriesPerRequest: 3,
    retryStrategy: createRedisRetryStrategy(options),
  };
}
