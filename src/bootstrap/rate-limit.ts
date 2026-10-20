import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { redis } from './cache.js';

export async function setupRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', redis });
}
