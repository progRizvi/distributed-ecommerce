import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../shared/events/event-bus.js';
import { TooManyRequestsError, UnauthorizedError } from '../../shared/errors/app-error.js';
import { toPublicUser } from '../users/users.mapper.js';
import { normalizeEmail, type UsersService } from '../users/users.service.js';
import type { PublicUser, User } from '../users/users.types.js';
import type { AuthRepository } from './auth.repository.js';
import type { AuthSession, RequestContext } from './auth.types.js';
import type { PasswordHasher } from './password.js';
import type { LoginThrottle } from './throttle.js';
import type { TokenService } from './tokens.js';

export interface AuthServiceDeps {
  users: UsersService;
  repo: AuthRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  throttle: LoginThrottle;
  events: EventBus;
  now?: () => Date;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

// Facade: routes call these few methods, and never see hashing, tokens or sessions.
export function createAuthService({ users, repo, hasher, tokens, throttle, events, now = () => new Date() }: AuthServiceDeps) {
  // Used when the email does not exist, so "unknown email" takes as long as "wrong password".
  const dummyHash = hasher.hash(randomUUID());

  const throttleKey = (email: string, ctx: RequestContext) => `${ctx.ip}:${normalizeEmail(email)}`;

  function buildSession(user: User, refresh: { token: string; expiresAt: Date }): AuthSession {
    return {
      user: toPublicUser(user),
      accessToken: tokens.issueAccessToken(user),
      expiresIn: tokens.accessTtlSeconds,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  // First token of a new login = new family.
  async function startSession(user: User, ctx: RequestContext): Promise<AuthSession> {
    const refresh = tokens.generateRefreshToken(now());
    await repo.create({
      userId: user.id,
      tokenHash: refresh.hash,
      familyId: randomUUID(),
      expiresAt: refresh.expiresAt,
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip,
    });
    return buildSession(user, refresh);
  }

  return {
    async register(input: { email: string; password: string }, ctx: RequestContext): Promise<AuthSession> {
      const passwordHash = await hasher.hash(input.password);
      // Duplicate email -> the repository throws ConflictError (409) from the unique index.
      const user = await users.create({ email: input.email, passwordHash });
      events.emit('user.registered', { userId: user.id, email: user.email });
      return startSession(user, ctx);
    },

    async login(input: { email: string; password: string }, ctx: RequestContext): Promise<AuthSession> {
      const key = throttleKey(input.email, ctx);
      if (await throttle.isBlocked(key)) {
        throw new TooManyRequestsError('Too many failed attempts, try again later');
      }

      const user = await users.findByEmail(input.email);
      const passwordOk = await hasher.verify(input.password, user?.passwordHash ?? (await dummyHash));

      // One message for every failure: the caller cannot tell if the email exists.
      if (!user || !passwordOk || user.status !== 'active') {
        await throttle.recordFailure(key);
        throw new UnauthorizedError(INVALID_CREDENTIALS);
      }

      await throttle.reset(key);
      return startSession(user, ctx);
    },

    async refresh(refreshToken: string, ctx: RequestContext): Promise<AuthSession> {
      const record = await repo.findByHash(tokens.hashRefreshToken(refreshToken));
      if (!record) throw new UnauthorizedError('Invalid refresh token');

      // An already-used token came back: it may be stolen. Kill the whole login family.
      if (record.revokedAt) {
        await repo.revokeFamily(record.familyId);
        throw new UnauthorizedError('Invalid refresh token');
      }
      if (record.expiresAt.getTime() <= now().getTime()) throw new UnauthorizedError('Refresh token expired');

      const user = await users.findById(record.userId);
      if (!user || user.status !== 'active') {
        await repo.revokeFamily(record.familyId);
        throw new UnauthorizedError('Invalid refresh token');
      }

      const next = tokens.generateRefreshToken(now());
      const rotated = await repo.rotate(record.id, {
        userId: user.id,
        tokenHash: next.hash,
        familyId: record.familyId,
        expiresAt: next.expiresAt,
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip,
      });
      // Lost a race with a parallel refresh using the same token: treat as reuse.
      if (!rotated) {
        await repo.revokeFamily(record.familyId);
        throw new UnauthorizedError('Invalid refresh token');
      }
      return buildSession(user, next);
    },

    // This device only. Always succeeds, even for an unknown token.
    async logout(refreshToken: string): Promise<void> {
      const record = await repo.findByHash(tokens.hashRefreshToken(refreshToken));
      if (record) await repo.revokeFamily(record.familyId);
    },

    async logoutAll(userId: string): Promise<void> {
      await repo.revokeAllForUser(userId);
    },

    async me(userId: string): Promise<PublicUser> {
      const user = await users.findById(userId);
      if (!user || user.status !== 'active') throw new UnauthorizedError();
      return toPublicUser(user);
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
