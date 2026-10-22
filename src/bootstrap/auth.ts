import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../shared/errors/app-error.js';
import type { Role } from '../modules/users/users.types.js';
import { env } from './env.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: Role };
    user: { sub: string; role: Role; iat: number; exp: number };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Route hook: needs a valid access token. Sets request.user. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Route hook: valid access token AND one of these roles. */
    requireRole: (...roles: Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function setupAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    // Token expires; a stolen token stops working after JWT_EXPIRES_IN.
    sign: { algorithm: 'HS256', expiresIn: env.JWT_EXPIRES_IN },
    // Only accept the algorithm we sign with.
    verify: { algorithms: ['HS256'] },
  });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    await request.jwtVerify();
  });

  app.decorate('requireRole', (...roles: Role[]) => async (request: FastifyRequest) => {
    await request.jwtVerify();
    if (!roles.includes(request.user.role)) throw new ForbiddenError();
  });
}
