import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '../users/users.types.js';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

export interface TokenServiceDeps {
  signAccess: (payload: AccessTokenPayload) => string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createTokenService({ signAccess, accessTtlSeconds, refreshTtlSeconds }: TokenServiceDeps) {
  return {
    accessTtlSeconds,

    issueAccessToken(user: { id: string; role: Role }): string {
      return signAccess({ sub: user.id, role: user.role });
    },

    // 256 bits of randomness. Only the sha256 is stored in the database.
    generateRefreshToken(now = new Date()): { token: string; hash: string; expiresAt: Date } {
      const token = randomBytes(32).toString('base64url');
      return { token, hash: hashRefreshToken(token), expiresAt: new Date(now.getTime() + refreshTtlSeconds * 1000) };
    },

    hashRefreshToken,
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
