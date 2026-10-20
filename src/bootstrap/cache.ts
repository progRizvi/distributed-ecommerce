import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { env } from './env.js';

export const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });

export async function setupCache(app: FastifyInstance): Promise<void> {
  await redis.connect();
  app.addHook('onClose', async () => {
    await redis.quit();
  });
}
