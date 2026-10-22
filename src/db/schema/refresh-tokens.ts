import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// No foreign key to users on purpose: modules stay separable (future microservices).
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    // sha256 of the token. The plain token is only ever in the user's cookie.
    tokenHash: text('token_hash').notNull().unique(),
    // All tokens from one login share a family. Reuse of an old token revokes the whole family.
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_user_id_idx').on(t.userId), index('refresh_tokens_family_id_idx').on(t.familyId)],
);
