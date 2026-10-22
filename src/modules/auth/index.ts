import type { FastifyPluginAsync } from 'fastify';
import { redis } from '../../bootstrap/cache.js';
import { env } from '../../bootstrap/env.js';
import { db } from '../../db/client.js';
import { createEventBus } from '../../shared/events/event-bus.js';
import { durationToSeconds } from '../../shared/utils/duration.js';
import { createUsersRepository } from '../users/users.repository.js';
import { createUsersService } from '../users/users.service.js';
import { createAuthController } from './auth.controller.js';
import { createAuthRepository } from './auth.repository.js';
import { createAuthRoutes } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createBcryptHasher } from './password.js';
import { createRedisLoginThrottle } from './throttle.js';
import { createTokenService } from './tokens.js';

export type { AuthSession, AuthId } from './auth.types.js';
export type { AuthService } from './auth.service.js';

// Composition root: the only place that connects the real pieces together.
// Everything else receives its dependencies as arguments, so tests can pass fakes.
export const authRoutes: FastifyPluginAsync = async (app) => {
  const users = createUsersService({ repo: createUsersRepository(db) });
  const tokens = createTokenService({
    signAccess: (payload) => app.jwt.sign(payload),
    accessTtlSeconds: durationToSeconds(env.JWT_EXPIRES_IN),
    refreshTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  });
  const service = createAuthService({
    users,
    repo: createAuthRepository(db),
    hasher: createBcryptHasher(env.BCRYPT_COST),
    tokens,
    throttle: createRedisLoginThrottle(redis),
    events: createEventBus((error, event) => app.log.error({ err: error, event }, 'event handler failed')),
  });
  const controller = createAuthController({ service, secureCookies: env.NODE_ENV === 'production' });

  await app.register(createAuthRoutes(controller));
};
