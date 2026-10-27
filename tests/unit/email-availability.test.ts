import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BloomFilter } from '../../src/shared/bloom/bloom-filter.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { stubTestEnv } from '../helpers/env.js';
import { createFakeAuthRepo, createFakeHasher, createFakeOutbox, createFakeTransactor, createFakeRevocations, createFakeThrottle, createFakeUsersRepo } from '../helpers/fakes.js';
import { createMemoryBitStore } from '../helpers/memory-bit-store.js';

function setup() {
  const repo = createFakeUsersRepo();
  const findByEmail = vi.spyOn(repo, 'findByEmail');
  const store = createMemoryBitStore();
  const filter = new BloomFilter(store, { name: 'email', expectedItems: 1000, falsePositiveRate: 0.01 });
  const errors: unknown[] = [];
  const users = new UsersService({ repo, emailFilter: filter, onFilterError: (e) => errors.push(e) });
  return { repo, findByEmail, store, filter, users, errors };
}

describe('isEmailAvailable with the Bloom filter', () => {
  it('unknown email: answers "available" without touching the database', async () => {
    const { users, findByEmail } = setup();
    expect(await users.isEmailAvailable('new@x.com')).toBe(true);
    expect(findByEmail).not.toHaveBeenCalled();
  });

  it('registered email: the filter says maybe, the database confirms it is taken', async () => {
    const { users, findByEmail } = setup();
    await users.create({ email: 'taken@x.com', passwordHash: 'h' });
    expect(await users.isEmailAvailable('taken@x.com')).toBe(false);
    expect(findByEmail).toHaveBeenCalledTimes(1);
  });

  it('is case and space insensitive', async () => {
    const { users } = setup();
    await users.create({ email: 'taken@x.com', passwordHash: 'h' });
    expect(await users.isEmailAvailable('  TAKEN@x.com ')).toBe(false);
  });

  it('filter false positive: the database says free, so the answer is "available"', async () => {
    const { users, filter, findByEmail } = setup();
    await filter.add('ghost@x.com'); // in the filter but not in the database
    expect(await users.isEmailAvailable('ghost@x.com')).toBe(true);
    expect(findByEmail).toHaveBeenCalledTimes(1);
  });

  it('filter missing an email (not rebuilt yet): the answer is wrong but harmless, register still returns 409', async () => {
    const { users, repo } = setup();
    await repo.create({ email: 'old@x.com', passwordHash: 'h', role: 'customer' }); // bypasses the filter
    expect(await users.isEmailAvailable('old@x.com')).toBe(true);
    await expect(users.create({ email: 'old@x.com', passwordHash: 'h' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('filter down: falls back to the database and reports the error', async () => {
    const { users, store, errors } = setup();
    await users.create({ email: 'taken@x.com', passwordHash: 'h' });
    store.failNext();
    expect(await users.isEmailAvailable('taken@x.com')).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('works without any filter', async () => {
    const users = new UsersService({ repo: createFakeUsersRepo() });
    await users.create({ email: 'a@x.com', passwordHash: 'h' });
    expect(await users.isEmailAvailable('a@x.com')).toBe(false);
    expect(await users.isEmailAvailable('b@x.com')).toBe(true);
  });
});

describe('create keeps the filter up to date', () => {
  it('adds the new email', async () => {
    const { users, filter } = setup();
    await users.create({ email: 'New@X.com', passwordHash: 'h' });
    expect(await filter.mightContain('new@x.com')).toBe(true);
  });

  it('still creates the user if the filter is down', async () => {
    const { users, store, errors, repo } = setup();
    store.failNext();
    const user = await users.create({ email: 'a@x.com', passwordHash: 'h' });
    expect(user.email).toBe('a@x.com');
    expect(repo.rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('a duplicate register does not touch the filter', async () => {
    const { users, store } = setup();
    await users.create({ email: 'a@x.com', passwordHash: 'h' });
    const calls = store.calls;
    await expect(users.create({ email: 'a@x.com', passwordHash: 'h' })).rejects.toMatchObject({ statusCode: 409 });
    expect(store.calls).toBe(calls);
  });
});

describe('listEmails (used by the rebuild script)', () => {
  it('pages through every email exactly once', async () => {
    const { repo } = setup();
    for (let i = 0; i < 7; i += 1) await repo.create({ email: `u${i}@x.com`, passwordHash: 'h', role: 'customer' });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await repo.listEmails(cursor, 3);
      if (page.length === 0) break;
      seen.push(...page.map((p) => p.email));
      cursor = page[page.length - 1]?.id;
    }
    expect(seen.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `u${i}@x.com`));
  });
});

describe('POST /api/auth/email-available', () => {
  afterEach(() => vi.unstubAllEnvs());

  async function buildApp() {
    stubTestEnv();
    const { setupErrorHandler } = await import('../../src/bootstrap/error-handler.js');
    const { setupCookie } = await import('../../src/bootstrap/cookie.js');
    const { setupAuth } = await import('../../src/bootstrap/auth.js');
    const { AuthController } = await import('../../src/modules/auth/auth.controller.js');
    const { createAuthRoutes } = await import('../../src/modules/auth/auth.routes.js');
    const { AuthService } = await import('../../src/modules/auth/auth.service.js');
    const { TokenService } = await import('../../src/modules/auth/tokens.js');
    const { InMemoryEventBus } = await import('../../src/shared/events/event-bus.js');

    const { users } = setup();
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await setupCookie(app);
    const { revocations } = createFakeRevocations();
    await setupAuth(app, revocations);
    setupErrorHandler(app);
    const service = new AuthService({
      users,
      repo: createFakeAuthRepo(),
      hasher: createFakeHasher(),
      tokens: new TokenService({ signAccess: (p) => app.jwt.sign(p), accessTtlSeconds: 900, refreshTtlSeconds: 3600 }),
      throttle: createFakeThrottle(),
      revocations,
      events: new InMemoryEventBus(),
      transactor: createFakeTransactor(),
      outbox: createFakeOutbox(),
    });
    await app.register(createAuthRoutes(new AuthController({ service, secureCookies: false })), { prefix: '/api/auth' });
    await app.ready();
    return app;
  }

  it('tells if an email is free or taken, and register fills the filter', async () => {
    const app = await buildApp();
    const check = (email: string) => app.inject({ method: 'POST', url: '/api/auth/email-available', payload: { email } });

    expect((await check('me@x.com')).json()).toEqual({ available: true });
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'me@x.com', password: 'password123' } });
    expect((await check('me@x.com')).json()).toEqual({ available: false });
    expect((await check('other@x.com')).json()).toEqual({ available: true });
  });

  it('400 for an invalid email', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/email-available', payload: { email: 'nope' } });
    expect(res.statusCode).toBe(400);
  });
});
