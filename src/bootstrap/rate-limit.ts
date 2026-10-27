import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { redis } from './cache.js';

// skipOnError: if Redis is down, let the request through instead of failing it.
// While that lasts there is no per-IP limit in the app. Nginx still has its own limit in front.
export async function setupRateLimit(app: FastifyInstance, client: Redis = redis): Promise<void> {
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', redis: client, skipOnError: true });
}
