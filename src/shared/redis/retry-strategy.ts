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
