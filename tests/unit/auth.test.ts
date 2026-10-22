import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://app:Zq8vK2mXp@db:5432/shop',
  REDIS_URL: 'redis://redis:6379',
  ELASTICSEARCH_URL: 'http://elasticsearch:9200',
  JWT_SECRET: 'k3Jx9Qw7Zt2Lm8Vb5Nc1Rd6Hy4Fa0Sg3',
  COOKIE_SECRET: 'Pw5Yd1Hn8Bv3Xk6Qe9Tz2Ma7Rc4Lf0Uj',
};

async function buildAuthApp(extra: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) vi.stubEnv(k, v);
  const { setupAuth } = await import('../../src/bootstrap/auth.js');
  const app = Fastify();
  await setupAuth(app);
  await app.ready();
  return app;
}

afterEach(() => vi.unstubAllEnvs());

describe('JWT expiry', () => {
  it('adds an exp claim (default 15m)', async () => {
    const app = await buildAuthApp();
    const decoded = app.jwt.decode<{ iat: number; exp: number }>(app.jwt.sign({ sub: 'u1', role: 'customer', sid: 's1' }));
    expect(decoded?.exp).toBeDefined();
    expect((decoded?.exp ?? 0) - (decoded?.iat ?? 0)).toBe(15 * 60);
    await app.close();
  });

  it('uses JWT_EXPIRES_IN from config', async () => {
    const app = await buildAuthApp({ JWT_EXPIRES_IN: '1h' });
    const decoded = app.jwt.decode<{ iat: number; exp: number }>(app.jwt.sign({ sub: 'u1', role: 'customer', sid: 's1' }));
    expect((decoded?.exp ?? 0) - (decoded?.iat ?? 0)).toBe(3600);
    await app.close();
  });

  it('rejects an expired token', async () => {
    const app = await buildAuthApp();
    const old = app.jwt.sign({ sub: 'u1', role: 'customer', sid: 's1' }, { expiresIn: '1s' });
    await new Promise((r) => setTimeout(r, 2100));
    expect(() => app.jwt.verify(old)).toThrow();
    await app.close();
  });
});
