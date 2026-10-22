import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { refreshTokens } from '../../db/schema/refresh-tokens.js';
import type { NewRefreshToken, RefreshTokenRecord } from './auth.types.js';

export interface AuthRepository {
  create(input: NewRefreshToken): Promise<RefreshTokenRecord>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined>;
  /** Revoke `oldId` and store `next` in one transaction. False if `oldId` was already revoked (parallel use). */
  rotate(oldId: string, next: NewRefreshToken): Promise<boolean>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

// Only this class talks to the refresh_tokens table. Tokens are revoked (marked), never removed.
export class DrizzleAuthRepository implements AuthRepository {
  constructor(private readonly db: Database) {}

  async create(input: NewRefreshToken): Promise<RefreshTokenRecord> {
    const [row] = await this.db.insert(refreshTokens).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const [row] = await this.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
    return row;
  }

  async rotate(oldId: string, next: NewRefreshToken): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // "AND revoked_at IS NULL" makes this atomic: only one parallel request can win.
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.id, oldId), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      if (revoked.length === 0) return false;
      await tx.insert(refreshTokens).values(next);
      return true;
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  }
}
