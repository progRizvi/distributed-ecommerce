import jwt from '@fastify/jwt';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';

export async function setupAuth(app: FastifyInstance): Promise<void> {
  await app.register(jwt, { secret: env.JWT_SECRET });
}
