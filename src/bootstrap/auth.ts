import jwt from '@fastify/jwt';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';

export async function setupAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    // Token expires; a stolen token stops working after JWT_EXPIRES_IN.
    sign: { algorithm: 'HS256', expiresIn: env.JWT_EXPIRES_IN },
    // Only accept the algorithm we sign with.
    verify: { algorithms: ['HS256'] },
  });
}
