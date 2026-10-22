import { vi } from 'vitest';

// Minimal valid config for tests that import code reading src/bootstrap/env.
export const testEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app:Zq8vK2mXp@db:5432/shop',
  REDIS_URL: 'redis://redis:6379',
  ELASTICSEARCH_URL: 'http://elasticsearch:9200',
  JWT_SECRET: 'k3Jx9Qw7Zt2Lm8Vb5Nc1Rd6Hy4Fa0Sg3',
  COOKIE_SECRET: 'Pw5Yd1Hn8Bv3Xk6Qe9Tz2Ma7Rc4Lf0Uj',
};

export function stubTestEnv(extra: Record<string, string> = {}): void {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries({ ...testEnv, ...extra })) vi.stubEnv(key, value);
}
