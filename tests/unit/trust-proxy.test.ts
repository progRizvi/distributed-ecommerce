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

async function clientIp(remoteAddress: string, forwardedFor: string, extra: Record<string, string> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) vi.stubEnv(k, v);
  const { trustProxy } = await import('../../src/bootstrap/proxy.js');
  const app = Fastify({ trustProxy });
  app.get('/ip', async (req) => req.ip);
  const res = await app.inject({
    url: '/ip',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
  });
  await app.close();
  return res.body;
}

afterEach(() => vi.unstubAllEnvs());

describe('trustProxy', () => {
  it('uses the real client IP when the request comes from a private proxy (Nginx)', async () => {
    expect(await clientIp('172.18.0.5', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('ignores a faked X-Forwarded-For from a public IP', async () => {
    expect(await clientIp('198.51.100.7', '1.2.3.4')).toBe('198.51.100.7');
  });

  it('ignores X-Forwarded-For when TRUST_PROXY=false', async () => {
    expect(await clientIp('172.18.0.5', '203.0.113.9', { TRUST_PROXY: 'false' })).toBe('172.18.0.5');
  });
});
