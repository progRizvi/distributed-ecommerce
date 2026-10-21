import { afterEach, describe, expect, it, vi } from 'vitest';

const base = {
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgresql://app:Zq8vK2mXp@db:5432/shop',
  REDIS_URL: 'redis://redis:6379',
  ELASTICSEARCH_URL: 'http://elasticsearch:9200',
  JWT_SECRET: 'k3Jx9Qw7Zt2Lm8Vb5Nc1Rd6Hy4Fa0Sg3',
  COOKIE_SECRET: 'Pw5Yd1Hn8Bv3Xk6Qe9Tz2Ma7Rc4Lf0Uj',
};

async function loadEnv(overrides: Record<string, string>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...base, ...overrides })) vi.stubEnv(k, v);
  return import('../../src/bootstrap/env.js');
}

afterEach(() => vi.unstubAllEnvs());

describe('env validation', () => {
  it('accepts a placeholder secret in development', async () => {
    const { env } = await loadEnv({ NODE_ENV: 'development', JWT_SECRET: 'change-me-change-me-change-me-change-me' });
    expect(env.NODE_ENV).toBe('development');
  });

  it('rejects a placeholder JWT_SECRET in production', async () => {
    await expect(
      loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'change-me-change-me-change-me-change-me' }),
    ).rejects.toThrow(/placeholder/);
  });

  it('rejects a placeholder database password in production', async () => {
    await expect(
      loadEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://app:change-me@db:5432/shop' }),
    ).rejects.toThrow(/placeholder/);
  });

  it('rejects COOKIE_SECRET equal to JWT_SECRET (any environment)', async () => {
    await expect(
      loadEnv({ NODE_ENV: 'development', COOKIE_SECRET: base.JWT_SECRET }),
    ).rejects.toThrow(/different from JWT_SECRET/);
  });

  it('rejects a placeholder COOKIE_SECRET in production', async () => {
    await expect(
      loadEnv({ NODE_ENV: 'production', COOKIE_SECRET: 'change-me-cookie-change-me-cookie-change' }),
    ).rejects.toThrow(/COOKIE_SECRET/);
  });

  it('accepts real values in production', async () => {
    const { env } = await loadEnv({ NODE_ENV: 'production' });
    expect(env.NODE_ENV).toBe('production');
  });
});
