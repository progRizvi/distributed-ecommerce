import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { DrizzleAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { DrizzleUsersRepository } from '../../src/modules/users/users.repository.js';
import * as schema from '../../src/db/schema/index.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';
import { randomUUID } from 'node:crypto';

// Real Postgres. Skipped unless TEST_DATABASE_URL points at a TEST database that already has the
// migrations applied. It only inserts rows (with random emails) and never removes any.
//   PowerShell:  $env:TEST_DATABASE_URL="postgresql://user:pass@localhost:5432/dbname"; pnpm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('auth against real Postgres', () => {
  const pool = new Pool({ connectionString: url, max: 20 });
  const db = drizzle(pool, { schema });
  const users = new DrizzleUsersRepository(db);
  const auth = new DrizzleAuthRepository(db);
  const unique = () => `it-${randomUUID()}@example.test`;

  afterAll(async () => {
    await pool.end();
  });

  it('10 parallel registrations of one email: exactly one wins, the rest are 409', async () => {
    const email = unique();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => users.create({ email, passwordHash: 'h', role: 'customer' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failures).toHaveLength(9);
    for (const f of failures) expect(f.reason).toBeInstanceOf(ConflictError);
  });

  it('email uniqueness ignores letter case', async () => {
    const email = unique();
    await users.create({ email, passwordHash: 'h', role: 'customer' });
    await expect(users.create({ email: email.toUpperCase(), passwordHash: 'h', role: 'customer' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('finds a user by normalized email and by id', async () => {
    const email = unique();
    const created = await users.create({ email, passwordHash: 'h', role: 'customer' });
    expect((await users.findByEmail(email))?.id).toBe(created.id);
    expect((await users.findById(created.id))?.email).toBe(email);
    expect(await users.findByEmail(unique())).toBeUndefined();
  });

  it('refresh rotation: only one of two parallel rotations succeeds', async () => {
    const user = await users.create({ email: unique(), passwordHash: 'h', role: 'customer' });
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const first = await auth.create({ userId: user.id, tokenHash: randomUUID(), familyId, expiresAt });

    const rotate = () => auth.rotate(first.id, { userId: user.id, tokenHash: randomUUID(), familyId, expiresAt });
    const results = await Promise.all([rotate(), rotate()]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('revokeFamily and revokeAllForUser mark tokens as revoked', async () => {
    const user = await users.create({ email: unique(), passwordHash: 'h', role: 'customer' });
    const expiresAt = new Date(Date.now() + 60_000);
    const familyId = randomUUID();
    const a = await auth.create({ userId: user.id, tokenHash: randomUUID(), familyId, expiresAt });
    const b = await auth.create({ userId: user.id, tokenHash: randomUUID(), familyId: randomUUID(), expiresAt });

    await auth.revokeFamily(familyId);
    expect((await auth.findByHash(a.tokenHash))?.revokedAt).not.toBeNull();
    expect((await auth.findByHash(b.tokenHash))?.revokedAt).toBeNull();

    await auth.revokeAllForUser(user.id);
    expect((await auth.findByHash(b.tokenHash))?.revokedAt).not.toBeNull();
  });
});
