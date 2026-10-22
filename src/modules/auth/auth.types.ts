import type { refreshTokens } from '../../db/schema/refresh-tokens.js';
import type { PublicUser } from '../users/users.types.js';

export type AuthId = string;
export type RefreshTokenRecord = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = Pick<
  typeof refreshTokens.$inferInsert,
  'userId' | 'tokenHash' | 'familyId' | 'expiresAt' | 'userAgent' | 'ip'
>;

// Who is calling (for session records and throttling).
export interface RequestContext {
  ip: string;
  userAgent?: string | undefined;
}

export interface AuthSession {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}
