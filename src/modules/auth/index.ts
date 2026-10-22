import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../../bootstrap/cache.js';
import { env } from '../../bootstrap/env.js';
import { db } from '../../db/client.js';
import { BloomFilter, RedisBitStore } from '../../shared/bloom/index.js';
import { InMemoryEventBus } from '../../shared/events/event-bus.js';
import { durationToSeconds } from '../../shared/utils/duration.js';
import { DrizzleUsersRepository } from '../users/users.repository.js';
import { UsersService } from '../users/users.service.js';
import { AuthController } from './auth.controller.js';
import { DrizzleAuthRepository } from './auth.repository.js';
import { createAuthRoutes } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { BcryptHasher } from './password.js';
import { RedisLoginThrottle } from './throttle.js';
import { TokenService } from './tokens.js';

export type { AuthSession, AuthId } from './auth.types.js';
export { AuthService } from './auth.service.js';

// Composition root: the only place that connects the real pieces together.
// Everything else receives its dependencies in its constructor, so tests can pass fakes.
export const authRoutes: FastifyPluginAsync = async (app) => {
  const emailFilter = new BloomFilter(new RedisBitStore(redis), {
    name: 'email',
    expectedItems: env.BLOOM_EXPECTED_ITEMS,
    falsePositiveRate: env.BLOOM_FALSE_POSITIVE_RATE,
  });
  const users = new UsersService({
    repo: new DrizzleUsersRepository(db),
    emailFilter,
    onFilterError: (error) => app.log.warn({ err: error }, 'email bloom filter failed, using database'),
  });
  const tokens = new TokenService({
    signAccess: (payload) => app.jwt.sign(payload),
    accessTtlSeconds: durationToSeconds(env.JWT_EXPIRES_IN),
    refreshTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
  const service = new AuthService({
    users,
    repo: new DrizzleAuthRepository(db),
    hasher: new BcryptHasher(env.BCRYPT_COST),
    tokens,
    throttle: new RedisLoginThrottle(redis),
    revocations: app.revocations, // same instance that `authenticate` reads
    onRevocationError: (error) => app.log.warn({ err: error }, 'could not write token revoke mark to Redis'),
    events: new InMemoryEventBus((error, event) => app.log.error({ err: error, event }, 'event handler failed')),
  });
  const controller = new AuthController({ service, secureCookies: env.NODE_ENV === 'production' });

  await app.register(createAuthRoutes(controller));
};
