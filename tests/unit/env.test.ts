import { afterEach, describe, expect, it, vi } from 'vitest';

const base = {
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgresql://app:Zq8vK2mXp@db:5432/shop',
  REDIS_URL: 'redis://redis:6379',
  ELASTICSEARCH_URL: 'http://elasticsearch:9200',
  JWT_SECRET: 'k3Jx9Qw7Zt2Lm8Vb5Nc1Rd6Hy4Fa0Sg3',
  COOKIE_SECRET: 'Pw5Yd1Hn8Bv3Xk6Qe9Tz2Ma7Rc4Lf0Uj',
  MAIL_DRIVER: 'smtp',
  SMTP_URL: 'smtps://mailer:Xq4wLp9z@smtp.provider.test:465',
  MAIL_FROM: 'Shop <no-reply@shop.test>',
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

  it('rejects the console mail driver in production (no email would ever be sent)', async () => {
    await expect(loadEnv({ NODE_ENV: 'production', MAIL_DRIVER: 'console' })).rejects.toThrow(/MAIL_DRIVER/);
  });

  it('allows the console mail driver in development', async () => {
    const { env } = await loadEnv({ NODE_ENV: 'development', MAIL_DRIVER: 'console' });
    expect(env.MAIL_DRIVER).toBe('console');
  });

  it('the smtp driver needs a valid SMTP_URL and a MAIL_FROM', async () => {
    await expect(loadEnv({ NODE_ENV: 'development', SMTP_URL: '' })).rejects.toThrow(/SMTP_URL/);
    await expect(loadEnv({ NODE_ENV: 'development', SMTP_URL: 'http://not-smtp.test' })).rejects.toThrow(/SMTP_URL/);
    await expect(loadEnv({ NODE_ENV: 'development', MAIL_FROM: '' })).rejects.toThrow(/MAIL_FROM/);
    await expect(loadEnv({ NODE_ENV: 'development', MAIL_FROM: 'a@x.com\r\nBcc: y@x.com' })).rejects.toThrow(/MAIL_FROM/);
  });

  it('accepts real values in production', async () => {
    const { env } = await loadEnv({ NODE_ENV: 'production' });
    expect(env.NODE_ENV).toBe('production');
  });
});
