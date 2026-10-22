import { describe, expect, it } from 'vitest';
import { BcryptHasher } from '../../src/modules/auth/password.js';
import { RedisLoginThrottle, type CounterStore } from '../../src/modules/auth/throttle.js';
import { TokenService } from '../../src/modules/auth/tokens.js';
import { normalizeEmail } from '../../src/modules/users/users.service.js';
import { InMemoryEventBus } from '../../src/shared/events/event-bus.js';
import { durationToSeconds } from '../../src/shared/utils/duration.js';

describe('durationToSeconds', () => {
  it('converts s, m, h, d', () => {
    expect(durationToSeconds('30s')).toBe(30);
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('1h')).toBe(3600);
    expect(durationToSeconds('7d')).toBe(604800);
  });
  it('rejects bad input', () => {
    expect(() => durationToSeconds('15')).toThrow();
    expect(() => durationToSeconds('abc')).toThrow();
  });
});

describe('bcrypt hasher', () => {
  const hasher = new BcryptHasher(4); // low cost = fast tests
  it('hashes and verifies', async () => {
    const hash = await hasher.hash('correct horse');
    expect(hash).not.toContain('correct horse');
    expect(hash.startsWith('$2')).toBe(true);
    expect(await hasher.verify('correct horse', hash)).toBe(true);
    expect(await hasher.verify('wrong horse', hash)).toBe(false);
  });
  it('gives a different hash each time (random salt)', async () => {
    expect(await hasher.hash('same')).not.toBe(await hasher.hash('same'));
  });
  it('returns false (not an error) for a broken hash', async () => {
    expect(await hasher.verify('x', 'not-a-bcrypt-hash')).toBe(false);
  });
  it('refuses passwords longer than 72 bytes', async () => {
    await expect(hasher.hash('a'.repeat(73))).rejects.toThrow();
  });
});

describe('token service', () => {
  const tokens = new TokenService({ signAccess: (p) => `${p.sub}:${p.role}:${p.sid}`, accessTtlSeconds: 900, refreshTtlSeconds: 3600 });
  it('makes unique, long refresh tokens and stores only their hash', () => {
    const a = tokens.generateRefreshToken();
    const b = tokens.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.hash).toBe(tokens.hashRefreshToken(a.token));
    expect(a.hash).not.toContain(a.token);
  });
  it('sets the expiry from the TTL', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(tokens.generateRefreshToken(now).expiresAt.toISOString()).toBe('2030-01-01T01:00:00.000Z');
  });
  it('puts user id and role in the access token', () => {
    expect(tokens.issueAccessToken({ id: 'u1', role: 'admin' }, 's1')).toBe('u1:admin:s1');
  });
});

describe('redis login throttle', () => {
  function fakeStore(): CounterStore & { data: Map<string, number>; ttl: Map<string, number> } {
    const data = new Map<string, number>();
    const ttl = new Map<string, number>();
    return {
      data,
      ttl,
      async get(key) {
        return data.has(key) ? String(data.get(key)) : null;
      },
      async incr(key) {
        data.set(key, (data.get(key) ?? 0) + 1);
        return data.get(key)!;
      },
      async expire(key, seconds) {
        ttl.set(key, seconds);
      },
      async del(key) {
        data.delete(key);
      },
    };
  }

  it('blocks at the limit, sets a TTL once, and resets', async () => {
    const store = fakeStore();
    const throttle = new RedisLoginThrottle(store, { maxFailures: 3, windowSeconds: 60 });
    expect(await throttle.isBlocked('k')).toBe(false);
    await throttle.recordFailure('k');
    await throttle.recordFailure('k');
    expect(await throttle.isBlocked('k')).toBe(false);
    await throttle.recordFailure('k');
    expect(await throttle.isBlocked('k')).toBe(true);
    expect([...store.ttl.values()]).toEqual([60]);
    await throttle.reset('k');
    expect(await throttle.isBlocked('k')).toBe(false);
  });

  it('never puts the plain email in the Redis key', async () => {
    const store = fakeStore();
    const throttle = new RedisLoginThrottle(store);
    await throttle.recordFailure('1.2.3.4:secret@person.com');
    expect([...store.data.keys()].join()).not.toContain('person.com');
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  A@X.Com ')).toBe('a@x.com');
  });
  it('folds lookalike unicode forms (NFKC)', () => {
    expect(normalizeEmail('ａ@x.com')).toBe('a@x.com'); // full-width "a"
  });
});

describe('event bus', () => {
  it('a failing listener does not break the emitter and is reported', async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus((e) => errors.push(e));
    bus.on('user.registered', () => {
      throw new Error('boom');
    });
    expect(() => bus.emit('user.registered', { userId: '1', email: 'a@x.com' })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveLength(1);
  });
});
