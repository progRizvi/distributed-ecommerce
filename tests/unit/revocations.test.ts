import { describe, expect, it } from 'vitest';
import { createFakeRevocations, createFakeRevocationStore } from '../helpers/fakes.js';
import { RedisTokenRevocations } from '../../src/modules/auth/revocations.js';

const T = 1_800_000_000; // a fixed "now" in seconds

describe('RedisTokenRevocations', () => {
  it('nothing is revoked at the start', async () => {
    const { revocations } = createFakeRevocations();
    expect(await revocations.isRevoked({ sub: 'u1', sid: 's1', iat: T })).toBe(false);
  });

  it('revokeSession kills that session only', async () => {
    const { revocations } = createFakeRevocations();
    await revocations.revokeSession('s1', 960);
    expect(await revocations.isRevoked({ sub: 'u1', sid: 's1', iat: T })).toBe(true);
    expect(await revocations.isRevoked({ sub: 'u1', sid: 's2', iat: T })).toBe(false); // other device
    expect(await revocations.isRevoked({ sub: 'u2', sid: 's3', iat: T })).toBe(false); // other user
  });

  it('revokeUser kills tokens issued before the mark, not the ones issued at or after it', async () => {
    const { revocations } = createFakeRevocations(() => T * 1000);
    await revocations.revokeUser('u1', 960);
    expect(await revocations.isRevoked({ sub: 'u1', sid: 'a', iat: T - 10 })).toBe(true); // old device
    expect(await revocations.isRevoked({ sub: 'u1', sid: 'b', iat: T })).toBe(false); // login in the same second as logout-all
    expect(await revocations.isRevoked({ sub: 'u1', sid: 'c', iat: T + 5 })).toBe(false); // login afterwards
    expect(await revocations.isRevoked({ sub: 'u2', sid: 'd', iat: T - 10 })).toBe(false); // other user
  });

  it('checks both marks with ONE Redis call', async () => {
    const { store, revocations } = createFakeRevocations();
    await revocations.isRevoked({ sub: 'u1', sid: 's1', iat: T });
    expect(store.calls).toBe(1);
  });

  it('sets a TTL (rounded up, at least 1 second) so marks clean themselves up', async () => {
    const store = createFakeRevocationStore();
    const revocations = new RedisTokenRevocations(store, () => T * 1000);
    await revocations.revokeSession('s1', 959.2);
    await revocations.revokeUser('u1', 0);
    expect(store.data.get('auth:revoked-sid:s1')?.ttl).toBe(960);
    expect(store.data.get('auth:revoked-after:u1')?.ttl).toBe(1);
  });

  it('a Redis error is thrown to the caller (the caller decides what to do)', async () => {
    const { store, revocations } = createFakeRevocations();
    store.failNext();
    await expect(revocations.isRevoked({ sub: 'u1', sid: 's1', iat: T })).rejects.toThrow('redis down');
  });
});
