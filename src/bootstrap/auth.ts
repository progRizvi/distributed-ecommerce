import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RedisTokenRevocations, type TokenRevocations } from '../modules/auth/revocations.js';
import type { Role } from '../modules/users/users.types.js';
import { ForbiddenError, UnauthorizedError } from '../shared/errors/app-error.js';
import { redis } from './cache.js';
import { env } from './env.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role; sid: string };
    user: { sub: string; role: Role; sid: string; iat: number; exp: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Route hook: needs a valid, not-revoked access token. Sets request.user. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route hook: valid access token AND one of these roles. */
    requireRole: (...roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Shared with the auth module, so logout writes the marks that authenticate reads. */
    revocations: TokenRevocations;
  }
}

export async function setupAuth(
  app: FastifyInstance,
  revocations: TokenRevocations = new RedisTokenRevocations(redis),
): Promise<void> {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    // Token expires; a stolen token stops working after JWT_EXPIRES_IN.
    sign: { algorithm: 'HS256', expiresIn: env.JWT_EXPIRES_IN },
    // Only accept the algorithm we sign with.
    verify: { algorithms: ['HS256'] },
  });

  app.decorate('revocations', revocations);

  async function authenticateRequest(request: FastifyRequest): Promise<void> {
    await request.jwtVerify();
    const { sub, sid, iat } = request.user;

    // If Redis is down we let the token through (it still expires on its own) instead of
    // locking every user out. This is logged, so you will see it.
    let revoked = false;
    try {
      revoked = await revocations.isRevoked({ sub, sid, iat });
    } catch (error) {
      request.log.warn({ err: error }, 'revocation check failed, allowing token');
    }
    if (revoked) throw new UnauthorizedError('Unauthorized');
  }

  app.decorate('authenticate', async (request: FastifyRequest) => {
    await authenticateRequest(request);
  });

  app.decorate('requireRole', (...roles: Role[]) => async (request: FastifyRequest) => {
    await authenticateRequest(request);
    if (!roles.includes(request.user.role)) throw new ForbiddenError();
  });
}
