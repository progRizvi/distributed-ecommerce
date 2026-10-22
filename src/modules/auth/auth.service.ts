import { randomUUID } from 'node:crypto';
import { TooManyRequestsError, UnauthorizedError } from '../../shared/errors/app-error.js';
import type { EventBus } from '../../shared/events/event-bus.js';
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
export class AuthService {
  private readonly users: UsersService;
  private readonly repo: AuthRepository;
  private readonly hasher: PasswordHasher;
  private readonly tokens: TokenService;
  private readonly throttle: LoginThrottle;
  private readonly events: EventBus;
  private readonly now: () => Date;
  // Used when the email does not exist, so "unknown email" takes as long as "wrong password".
  private readonly dummyHash: Promise<string>;

  constructor(deps: AuthServiceDeps) {
    this.users = deps.users;
    this.repo = deps.repo;
    this.hasher = deps.hasher;
    this.tokens = deps.tokens;
    this.throttle = deps.throttle;
    this.events = deps.events;
    this.now = deps.now ?? (() => new Date());
    this.dummyHash = deps.hasher.hash(randomUUID());
    this.dummyHash.catch(() => {}); // a failure is reported when login awaits it, not as an unhandled rejection
  }

  async register(input: { email: string; password: string }, ctx: RequestContext): Promise<AuthSession> {
    const passwordHash = await this.hasher.hash(input.password);
    // Duplicate email -> the repository throws ConflictError (409) from the unique index.
    const user = await this.users.create({ email: input.email, passwordHash });
    this.events.emit('user.registered', { userId: user.id, email: user.email });
    return this.startSession(user, ctx);
  }

  async login(input: { email: string; password: string }, ctx: RequestContext): Promise<AuthSession> {
    const key = this.throttleKey(input.email, ctx);
    if (await this.throttle.isBlocked(key)) {
      throw new TooManyRequestsError('Too many failed attempts, try again later');
    }

    const user = await this.users.findByEmail(input.email);
    const passwordOk = await this.hasher.verify(input.password, user?.passwordHash ?? (await this.dummyHash));

    // One message for every failure: the caller cannot tell if the email exists.
    if (!user || !passwordOk || user.status !== 'active') {
      await this.throttle.recordFailure(key);
      throw new UnauthorizedError(INVALID_CREDENTIALS);
    }

    await this.throttle.reset(key);
    return this.startSession(user, ctx);
  }

  // Only a hint for the sign-up form. Register still decides for real (unique index).
  async emailAvailable(email: string): Promise<boolean> {
    return this.users.isEmailAvailable(email);
  }

  async refresh(refreshToken: string, ctx: RequestContext): Promise<AuthSession> {
    const record = await this.repo.findByHash(this.tokens.hashRefreshToken(refreshToken));
    if (!record) throw new UnauthorizedError('Invalid refresh token');

    // An already-used token came back: it may be stolen. Kill the whole login family.
    if (record.revokedAt) {
      await this.repo.revokeFamily(record.familyId);
      throw new UnauthorizedError('Invalid refresh token');
    }
    if (record.expiresAt.getTime() <= this.now().getTime()) throw new UnauthorizedError('Refresh token expired');

    const user = await this.users.findById(record.userId);
    if (!user || user.status !== 'active') {
      await this.repo.revokeFamily(record.familyId);
      throw new UnauthorizedError('Invalid refresh token');
    }

    const next = this.tokens.generateRefreshToken(this.now());
    const rotated = await this.repo.rotate(record.id, {
      userId: user.id,
      tokenHash: next.hash,
      familyId: record.familyId,
      expiresAt: next.expiresAt,
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip,
    });
    // Lost a race with a parallel refresh using the same token: treat as reuse.
    if (!rotated) {
      await this.repo.revokeFamily(record.familyId);
      throw new UnauthorizedError('Invalid refresh token');
    }
    return this.buildSession(user, next);
  }

  // This device only. Always succeeds, even for an unknown token.
  async logout(refreshToken: string): Promise<void> {
    const record = await this.repo.findByHash(this.tokens.hashRefreshToken(refreshToken));
    if (record) await this.repo.revokeFamily(record.familyId);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.repo.revokeAllForUser(userId);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user || user.status !== 'active') throw new UnauthorizedError();
    return toPublicUser(user);
  }

  private throttleKey(email: string, ctx: RequestContext): string {
    return `${ctx.ip}:${normalizeEmail(email)}`;
  }

  private buildSession(user: User, refresh: { token: string; expiresAt: Date }): AuthSession {
    return {
      user: toPublicUser(user),
      accessToken: this.tokens.issueAccessToken(user),
      expiresIn: this.tokens.accessTtlSeconds,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  // First token of a new login = new family.
  private async startSession(user: User, ctx: RequestContext): Promise<AuthSession> {
    const refresh = this.tokens.generateRefreshToken(this.now());
    await this.repo.create({
      userId: user.id,
      tokenHash: refresh.hash,
      familyId: randomUUID(),
      expiresAt: refresh.expiresAt,
      userAgent: ctx.userAgent ?? null,
      ip: ctx.ip,
    });
    return this.buildSession(user, refresh);
  }
}
