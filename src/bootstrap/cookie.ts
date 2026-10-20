import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';

export async function setupCookie(app: FastifyInstance): Promise<void> {
  await app.register(cookie, { secret: env.JWT_SECRET });
}
