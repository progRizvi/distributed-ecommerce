import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';

export async function setupCors(app: FastifyInstance): Promise<void> {
  await app.register(cors, { origin: env.CORS_ORIGIN.split(','), credentials: true });
}
