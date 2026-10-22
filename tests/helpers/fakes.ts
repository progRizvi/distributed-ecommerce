import { randomUUID } from 'node:crypto';
import type { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import type { NewRefreshToken, RefreshTokenRecord } from '../../src/modules/auth/auth.types.js';
import type { PasswordHasher } from '../../src/modules/auth/password.js';
import type { LoginThrottle } from '../../src/modules/auth/throttle.js';
import type { UsersRepository } from '../../src/modules/users/users.repository.js';
import type { NewUser, User } from '../../src/modules/users/users.types.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';

export function createFakeUsersRepo(): UsersRepository & { rows: User[] } {
  const rows: User[] = [];
  return {
    rows,
    async findByEmail(email) {
      return rows.find((u) => u.email.toLowerCase() === email);
    },
    async findById(id) {
      return rows.find((u) => u.id === id);
    },
    async listEmails(afterId, limit) {
      return [...rows]
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((u) => !afterId || u.id > afterId)
        .slice(0, limit)
        .map((u) => ({ id: u.id, email: u.email }));
    },
    async create(input: NewUser) {
      // Same behaviour as the real unique index.
      if (rows.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
        throw new ConflictError('Email already registered');
      }
      const user: User = {
        id: randomUUID(),
        email: input.email,
        passwordHash: input.passwordHash,
        role: input.role ?? 'customer',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(user);
      return user;
    },
  };
}

export function createFakeAuthRepo(): AuthRepository & { rows: RefreshTokenRecord[] } {
  const rows: RefreshTokenRecord[] = [];
  const add = (input: NewRefreshToken): RefreshTokenRecord => {
    const row: RefreshTokenRecord = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      createdAt: new Date(),
    };
    rows.push(row);
    return row;
  };
  return {
    rows,
    async create(input) {
      return add(input);
    },
    async findByHash(tokenHash) {
      return rows.find((r) => r.tokenHash === tokenHash);
    },
    async rotate(oldId, next) {
      const old = rows.find((r) => r.id === oldId);
      if (!old || old.revokedAt) return false;
      old.revokedAt = new Date();
      add(next);
      return true;
    },
    async revokeFamily(familyId) {
      for (const r of rows) if (r.familyId === familyId && !r.revokedAt) r.revokedAt = new Date();
    },
    async revokeAllForUser(userId) {
      for (const r of rows) if (r.userId === userId && !r.revokedAt) r.revokedAt = new Date();
    },
  };
}

// Fast and fake. Real bcrypt is tested separately.
export function createFakeHasher(): PasswordHasher & { verifyCalls: number } {
  const hasher = {
    verifyCalls: 0,
    async hash(plain: string) {
      return `hashed:${plain}`;
    },
    async verify(plain: string, hash: string) {
      hasher.verifyCalls += 1;
      return hash === `hashed:${plain}`;
    },
  };
  return hasher;
}

export function createFakeThrottle(maxFailures = 5): LoginThrottle & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async isBlocked(key) {
      return (counts.get(key) ?? 0) >= maxFailures;
    },
    async recordFailure(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    async reset(key) {
      counts.set(key, 0);
    },
  };
}
