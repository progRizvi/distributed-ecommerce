import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuthRepo, createFakeHasher, createFakeOutbox, createFakeTransactor, createFakeRevocations, createFakeThrottle, createFakeUsersRepo } from '../helpers/fakes.js';
import { stubTestEnv } from '../helpers/env.js';

// Real bootstrap pieces (cookie, jwt, error handler, zod) + real routes/controller/service + fake database.
async function buildTestApp() {
  stubTestEnv();
  const { setupAuth } = await import('../../src/bootstrap/auth.js');
  const { setupCookie } = await import('../../src/bootstrap/cookie.js');
  const { setupErrorHandler } = await import('../../src/bootstrap/error-handler.js');
  const { AuthController } = await import('../../src/modules/auth/auth.controller.js');
  const { createAuthRoutes } = await import('../../src/modules/auth/auth.routes.js');
  const { AuthService } = await import('../../src/modules/auth/auth.service.js');
  const { TokenService } = await import('../../src/modules/auth/tokens.js');
  const { UsersService } = await import('../../src/modules/users/users.service.js');
  const { InMemoryEventBus } = await import('../../src/shared/events/event-bus.js');

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await setupCookie(app);
  const { store: revocationStore, revocations } = createFakeRevocations(() => Date.now() + 2000); // +2s: logout-all lands after tokens issued in this same second
  await setupAuth(app, revocations);
  setupErrorHandler(app);

  const usersRepo = createFakeUsersRepo();
  const service = new AuthService({
    users: new UsersService({ repo: usersRepo }),
    repo: createFakeAuthRepo(),
    hasher: createFakeHasher(),
    tokens: new TokenService({ signAccess: (p) => app.jwt.sign(p), accessTtlSeconds: 900, refreshTtlSeconds: 3600 }),
    throttle: createFakeThrottle(5),
    revocations,
    events: new InMemoryEventBus(),
    transactor: createFakeTransactor(),
    outbox: createFakeOutbox(),
  });
  await app.register(createAuthRoutes(new AuthController({ service, secureCookies: false })), { prefix: '/api/auth' });
  app.get('/admin-only', { onRequest: [app.requireRole('admin')] }, async () => ({ ok: true }));
  await app.ready();
  return { app, usersRepo, revocationStore };
}

const creds = { email: 'a@x.com', password: 'password123' };

async function registered() {
  const ctx = await buildTestApp();
  const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
  const cookie = res.cookies.find((c) => c.name === 'refresh_token');
  return { ...ctx, res, body: res.json(), refreshCookie: cookie?.value ?? '' };
}

afterEach(() => vi.unstubAllEnvs());

describe('POST /register', () => {
  it('201, access token in body, refresh token only in a safe cookie', async () => {
    const { res, body } = await registered();
    expect(res.statusCode).toBe(201);
    expect(body.accessToken).toBeTypeOf('string');
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);
    expect(body.user.email).toBe('a@x.com');
    expect(body).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(body)).not.toContain('hashed:');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('refresh_token=');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toContain('Path=/api/auth');
  });

  it('400 with field details for a bad email or a short password', async () => {
    const { app } = await buildTestApp();
    const badEmail = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'nope', password: 'password123' } });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json().error).toBe('VALIDATION_ERROR');
    expect(badEmail.json().details.length).toBeGreaterThan(0);

    const short = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'short' } });
    expect(short.statusCode).toBe(400);
  });

  it('400 for a password longer than 72 bytes', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'é'.repeat(40) } });
    expect(res.statusCode).toBe(400);
  });

  it('409 for a duplicate email', async () => {
    const { app } = await registered();
    const again = await app.inject({ method: 'POST', url: '/api/auth/register', payload: creds });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('CONFLICT');
  });
});

describe('POST /login', () => {
  it('200 with the right password', async () => {
    const { app } = await registered();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf('string');
  });

  it('401 with one generic message for wrong password and unknown email', async () => {
    const { app } = await registered();
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...creds, password: 'wrong-pass1' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'z@x.com', password: 'wrong-pass1' } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('429 after too many failures', async () => {
    const { app } = await registered();
    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...creds, password: 'wrong-pass1' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds });
    expect(res.statusCode).toBe(429);
  });
});

describe('GET /me and access control', () => {
  it('401 without a token, with a garbage token, and with a token signed by someone else', async () => {
    const { app } = await registered();
    expect((await app.inject('/api/auth/me')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: 'Bearer garbage' } })).statusCode).toBe(401);

    const forged = Fastify();
    const jwt = (await import('@fastify/jwt')).default;
    await forged.register(jwt, { secret: 'another-secret-another-secret-another!' });
    const fake = forged.jwt.sign({ sub: 'x', role: 'admin', sid: 'admin-session' });
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${fake}` } })).statusCode).toBe(401);
  });

  it('200 with a valid token', async () => {
    const { app, body } = await registered();
    const res = await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('a@x.com');
  });

  it('requireRole: customer gets 403, admin gets 200, no token gets 401', async () => {
    const { app, usersRepo, body } = await registered();
    const asCustomer = await app.inject({ url: '/admin-only', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(asCustomer.statusCode).toBe(403);

    expect((await app.inject('/admin-only')).statusCode).toBe(401);

    usersRepo.rows[0]!.role = 'admin';
    const adminToken = app.jwt.sign({ sub: usersRepo.rows[0]!.id, role: 'admin', sid: 'admin-session' });
    const asAdmin = await app.inject({ url: '/admin-only', headers: { authorization: `Bearer ${adminToken}` } });
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe('POST /refresh', () => {
  it('200 and a new cookie, using the cookie', async () => {
    const { app, refreshCookie } = await registered();
    const res = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } });
    expect(res.statusCode).toBe(200);
    const next = res.cookies.find((c) => c.name === 'refresh_token');
    expect(next?.value).toBeTruthy();
    expect(next?.value).not.toBe(refreshCookie);
  });

  it('401 without a cookie, and with a forged (unsigned) cookie', async () => {
    const { app } = await registered();
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: 'plain-guess' } })).statusCode).toBe(401);
  });

  it('401 when an old cookie is replayed, and the new one dies too', async () => {
    const { app, refreshCookie } = await registered();
    const ok = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } });
    const newCookie = ok.cookies.find((c) => c.name === 'refresh_token')!.value;

    const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } });
    expect(replay.statusCode).toBe(401);

    const afterTheft = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: newCookie } });
    expect(afterTheft.statusCode).toBe(401);
  });
});

describe('logout', () => {
  it('204, clears the cookie, and the old cookie stops working', async () => {
    const { app, refreshCookie } = await registered();
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { refresh_token: refreshCookie } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/refresh_token=;/);

    const after = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } });
    expect(after.statusCode).toBe(401);
  });

  it('logout works even without a cookie', async () => {
    const { app } = await registered();
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
  });

  it('logout-all needs a token, then revokes the session', async () => {
    const { app, body, refreshCookie } = await registered();
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout-all' })).statusCode).toBe(401);

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe('access token is revoked by logout (not only the refresh token)', () => {
  const me = (app: Awaited<ReturnType<typeof buildTestApp>>['app'], token: string) =>
    app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });

  it('logout: the access token of this device stops working at once', async () => {
    const { app, body, refreshCookie } = await registered();
    expect((await me(app, body.accessToken)).statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { refresh_token: refreshCookie } });

    expect((await me(app, body.accessToken)).statusCode).toBe(401);
  });

  it('logout: another device of the same user keeps working', async () => {
    const { app, body, refreshCookie } = await registered();
    const otherDevice = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds })).json();

    await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { refresh_token: refreshCookie } });

    expect((await me(app, body.accessToken)).statusCode).toBe(401);
    expect((await me(app, otherDevice.accessToken)).statusCode).toBe(200);
  });

  it('logout-all: the access tokens of every device stop working', async () => {
    const { app, body } = await registered();
    const otherDevice = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds })).json();

    const out = await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(out.statusCode).toBe(204);

    expect((await me(app, body.accessToken)).statusCode).toBe(401);
    expect((await me(app, otherDevice.accessToken)).statusCode).toBe(401);
  });

  it("logout-all does not affect another user's token", async () => {
    const { app, body } = await registered();
    const other = (await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'b@x.com', password: 'password123' } })).json();

    await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: { authorization: `Bearer ${body.accessToken}` } });

    expect((await me(app, other.accessToken)).statusCode).toBe(200);
  });

  it('a stolen refresh token being replayed also kills the access token of that session', async () => {
    const { app, body, refreshCookie } = await registered();
    await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } });

    await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } }); // replay

    expect((await me(app, body.accessToken)).statusCode).toBe(401);
  });

  it('requireRole also honours revocation', async () => {
    const { app, usersRepo, revocationStore } = await registered();
    usersRepo.rows[0]!.role = 'admin';
    const token = app.jwt.sign({ sub: usersRepo.rows[0]!.id, role: 'admin', sid: 'admin-session' });
    expect((await app.inject({ url: '/admin-only', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);

    revocationStore.data.set('auth:revoked-sid:admin-session', { value: '1', ttl: 960 });

    expect((await app.inject({ url: '/admin-only', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });

  it('if Redis is down the token is still accepted (fail open), not a 500', async () => {
    const { app, body, revocationStore } = await registered();
    revocationStore.failNext();
    const res = await me(app, body.accessToken);
    expect(res.statusCode).toBe(200);
  });

  it('if Redis is down, logout still works (204) and the refresh cookie is dead', async () => {
    const { app, refreshCookie, revocationStore } = await registered();
    revocationStore.failNext();
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { refresh_token: refreshCookie } });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { refresh_token: refreshCookie } })).statusCode).toBe(401);
  });
});
