import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TokenService } from '../../src/modules/auth/tokens.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { ConflictError, TooManyRequestsError, UnauthorizedError } from '../../src/shared/errors/app-error.js';
import { InMemoryEventBus } from '../../src/shared/events/event-bus.js';
import { createFakeAuthRepo, createFakeHasher, createFakeRevocations, createFakeThrottle, createFakeUsersRepo } from '../helpers/fakes.js';

const ctx = { ip: '203.0.113.9', userAgent: 'vitest' };

function setup(options: { now?: () => Date } = {}) {
  const usersRepo = createFakeUsersRepo();
  const authRepo = createFakeAuthRepo();
  const hasher = createFakeHasher();
  const throttle = createFakeThrottle(5);
  const { store: revocationStore, revocations } = createFakeRevocations();
  const revocationErrors: unknown[] = [];
  const registered: unknown[] = [];
  const events = new InMemoryEventBus();
  events.on('user.registered', (p) => {
    registered.push(p);
  });
  const tokens = new TokenService({
    signAccess: (p) => `access.${p.sub}.${p.role}.${p.sid}`,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 3600,
  });
  const service = new AuthService({
    users: new UsersService({ repo: usersRepo }),
    repo: authRepo,
    hasher,
    tokens,
    throttle,
    revocations,
    onRevocationError: (error) => revocationErrors.push(error),
    events,
    ...(options.now ? { now: options.now } : {}),
  });
  return { service, usersRepo, authRepo, hasher, throttle, tokens, registered, revocationStore, revocationErrors };
}

describe('register', () => {
  it('creates a user and a session without leaking the password hash', async () => {
    const { service, usersRepo } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);

    expect(session.user.email).toBe('a@x.com');
    expect(session.user.role).toBe('customer');
    expect(session.accessToken).toContain('access.');
    expect(session.expiresIn).toBe(900);
    expect(JSON.stringify(session)).not.toContain('hashed:');
    expect(usersRepo.rows[0]?.passwordHash).toBe('hashed:password123');
  });

  it('normalizes the email (trim, case)', async () => {
    const { service, usersRepo } = setup();
    await service.register({ email: '  Bob@X.COM ', password: 'password123' }, ctx);
    expect(usersRepo.rows[0]?.email).toBe('bob@x.com');
  });

  it('rejects a duplicate email, also with different letter case', async () => {
    const { service } = setup();
    await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await expect(service.register({ email: 'A@X.com', password: 'password123' }, ctx)).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores only the hash of the refresh token', async () => {
    const { service, authRepo, tokens } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    expect(authRepo.rows).toHaveLength(1);
    expect(authRepo.rows[0]?.tokenHash).not.toBe(session.refreshToken);
    expect(authRepo.rows[0]?.tokenHash).toBe(tokens.hashRefreshToken(session.refreshToken));
  });

  it('emits user.registered', async () => {
    const { service, registered } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await new Promise((r) => setImmediate(r));
    expect(registered).toEqual([{ userId: session.user.id, email: 'a@x.com' }]);
  });
});

describe('login', () => {
  async function withUser() {
    const s = setup();
    await s.service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    return s;
  }

  it('logs in with the right password (email case does not matter)', async () => {
    const { service } = await withUser();
    const session = await service.login({ email: 'A@x.com', password: 'password123' }, ctx);
    expect(session.user.email).toBe('a@x.com');
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { service } = await withUser();
    const wrong = await service.login({ email: 'a@x.com', password: 'nope-nope' }, ctx).catch((e: unknown) => e);
    const unknown = await service.login({ email: 'nobody@x.com', password: 'nope-nope' }, ctx).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(UnauthorizedError);
    expect(unknown).toBeInstanceOf(UnauthorizedError);
    expect((wrong as Error).message).toBe((unknown as Error).message);
  });

  it('still verifies a password when the email is unknown (same timing)', async () => {
    const { service, hasher } = await withUser();
    const before = hasher.verifyCalls;
    await service.login({ email: 'nobody@x.com', password: 'whatever1' }, ctx).catch(() => {});
    expect(hasher.verifyCalls).toBe(before + 1);
  });

  it('refuses disabled users', async () => {
    const { service, usersRepo } = await withUser();
    usersRepo.rows[0]!.status = 'disabled';
    await expect(service.login({ email: 'a@x.com', password: 'password123' }, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('blocks after 5 failures, even with the right password', async () => {
    const { service } = await withUser();
    for (let i = 0; i < 5; i += 1) {
      await service.login({ email: 'a@x.com', password: 'wrong-pass' }, ctx).catch(() => {});
    }
    await expect(service.login({ email: 'a@x.com', password: 'password123' }, ctx)).rejects.toBeInstanceOf(TooManyRequestsError);
  });

  it('does not block another IP', async () => {
    const { service } = await withUser();
    for (let i = 0; i < 5; i += 1) {
      await service.login({ email: 'a@x.com', password: 'wrong-pass' }, ctx).catch(() => {});
    }
    const session = await service.login({ email: 'a@x.com', password: 'password123' }, { ip: '198.51.100.1' });
    expect(session.user.email).toBe('a@x.com');
  });

  it('a successful login resets the failure counter', async () => {
    const { service } = await withUser();
    for (let i = 0; i < 4; i += 1) {
      await service.login({ email: 'a@x.com', password: 'wrong-pass' }, ctx).catch(() => {});
    }
    await service.login({ email: 'a@x.com', password: 'password123' }, ctx);
    for (let i = 0; i < 4; i += 1) {
      await service.login({ email: 'a@x.com', password: 'wrong-pass' }, ctx).catch(() => {});
    }
    await expect(service.login({ email: 'a@x.com', password: 'password123' }, ctx)).resolves.toBeDefined();
  });
});

describe('refresh', () => {
  it('rotates: new token works, old token is revoked, same family', async () => {
    const { service, authRepo } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const second = await service.refresh(first.refreshToken, ctx);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(authRepo.rows).toHaveLength(2);
    expect(authRepo.rows[0]?.revokedAt).not.toBeNull();
    expect(authRepo.rows[1]?.revokedAt).toBeNull();
    expect(authRepo.rows[1]?.familyId).toBe(authRepo.rows[0]?.familyId);
  });

  it('reusing an old token revokes the whole family (theft detection)', async () => {
    const { service, authRepo } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const second = await service.refresh(first.refreshToken, ctx);

    await expect(service.refresh(first.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
    // The newest token is dead too.
    expect(authRepo.rows.every((r) => r.revokedAt)).toBe(true);
    await expect(service.refresh(second.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('only one of two parallel refreshes with the same token wins', async () => {
    const { service } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const results = await Promise.allSettled([service.refresh(first.refreshToken, ctx), service.refresh(first.refreshToken, ctx)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('rejects unknown and expired tokens', async () => {
    let time = new Date('2030-01-01T00:00:00Z');
    const { service } = setup({ now: () => time });
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);

    await expect(service.refresh('not-a-real-token', ctx)).rejects.toBeInstanceOf(UnauthorizedError);

    time = new Date('2030-01-01T02:00:00Z'); // refresh TTL in this test is 1 hour
    await expect(service.refresh(first.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('revokes the session if the user got disabled', async () => {
    const { service, usersRepo, authRepo } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    usersRepo.rows[0]!.status = 'disabled';
    await expect(service.refresh(first.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authRepo.rows.every((r) => r.revokedAt)).toBe(true);
  });
});

describe('logout', () => {
  it('logout revokes this login; refresh no longer works', async () => {
    const { service } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await service.logout(session.refreshToken);
    await expect(service.refresh(session.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('logout with an unknown token does not fail', async () => {
    const { service } = setup();
    await expect(service.logout('unknown')).resolves.toBeUndefined();
  });

  it('logoutAll revokes every device of the user, but not other users', async () => {
    const { service } = setup();
    const phone = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const laptop = await service.login({ email: 'a@x.com', password: 'password123' }, ctx);
    const other = await service.register({ email: 'b@x.com', password: 'password123' }, ctx);

    await service.logoutAll(phone.user.id);

    await expect(service.refresh(phone.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.refresh(laptop.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(service.refresh(other.refreshToken, ctx)).resolves.toBeDefined();
  });
});

describe('access token revocation', () => {
  const ACCESS_TTL_PLUS_MARGIN = 900 + 60;

  it('the access token carries the session id (= refresh token family), and refresh keeps it', async () => {
    const { service, authRepo } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const familyId = authRepo.rows[0]!.familyId;
    expect(first.accessToken.endsWith(`.${familyId}`)).toBe(true);

    const second = await service.refresh(first.refreshToken, ctx);
    expect(second.accessToken.endsWith(`.${familyId}`)).toBe(true);
  });

  it('logout marks this session as revoked, with a TTL just over the access token life', async () => {
    const { service, authRepo, revocationStore } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const familyId = authRepo.rows[0]!.familyId;

    await service.logout(session.refreshToken);

    expect(revocationStore.data.get(`auth:revoked-sid:${familyId}`)).toEqual({ value: '1', ttl: ACCESS_TTL_PLUS_MARGIN });
  });

  it('logout with an unknown token writes nothing', async () => {
    const { service, revocationStore } = setup();
    await service.logout('unknown');
    expect(revocationStore.data.size).toBe(0);
  });

  it('logoutAll marks the user as revoked-after-now', async () => {
    const { service, revocationStore } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);

    await service.logoutAll(session.user.id);

    const mark = revocationStore.data.get(`auth:revoked-after:${session.user.id}`);
    expect(mark?.ttl).toBe(ACCESS_TTL_PLUS_MARGIN);
    expect(Number(mark?.value)).toBeGreaterThan(1_700_000_000);
  });

  it('a stolen (reused) refresh token also revokes the access tokens of that session', async () => {
    const { service, authRepo, revocationStore } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const familyId = authRepo.rows[0]!.familyId;
    await service.refresh(first.refreshToken, ctx);

    await service.refresh(first.refreshToken, ctx).catch(() => {});

    expect(revocationStore.data.has(`auth:revoked-sid:${familyId}`)).toBe(true);
  });

  it('a disabled user session is revoked on refresh', async () => {
    const { service, usersRepo, authRepo, revocationStore } = setup();
    const first = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const familyId = authRepo.rows[0]!.familyId;
    usersRepo.rows[0]!.status = 'disabled';

    await service.refresh(first.refreshToken, ctx).catch(() => {});

    expect(revocationStore.data.has(`auth:revoked-sid:${familyId}`)).toBe(true);
  });

  it('if Redis is down, logout still revokes the refresh token and reports the error', async () => {
    const { service, authRepo, revocationStore, revocationErrors } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);

    revocationStore.failNext();
    await expect(service.logout(session.refreshToken)).resolves.toBeUndefined();

    expect(authRepo.rows.every((r) => r.revokedAt)).toBe(true);
    expect(revocationErrors).toHaveLength(1);
    await expect(service.refresh(session.refreshToken, ctx)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('if Redis is down, logoutAll still revokes every refresh token and reports the error', async () => {
    const { service, authRepo, revocationStore, revocationErrors } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);

    revocationStore.failNext();
    await expect(service.logoutAll(session.user.id)).resolves.toBeUndefined();

    expect(authRepo.rows.every((r) => r.revokedAt)).toBe(true);
    expect(revocationErrors).toHaveLength(1);
  });
});

describe('me', () => {
  it('returns the public user', async () => {
    const { service } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    const me = await service.me(session.user.id);
    expect(me.email).toBe('a@x.com');
    expect(JSON.stringify(me)).not.toContain('hashed:');
  });

  it('fails for an unknown user id', async () => {
    const { service } = setup();
    await expect(service.me('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
