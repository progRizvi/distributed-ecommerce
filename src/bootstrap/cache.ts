import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { resilientRedisOptions } from '../shared/redis/retry-strategy.js';
import { env } from './env.js';

// Everything that uses this client must still work (or fail soft) when Redis is down.
// See resilientRedisOptions: commands fail at once instead of waiting for a reconnect.
export const redis = new Redis(env.REDIS_URL, { lazyConnect: true, ...resilientRedisOptions() });

export async function setupCache(app: FastifyInstance): Promise<void> {
  // Without a listener ioredis prints raw errors. This keeps them in our structured log.
  redis.on('error', (error) => app.log.warn({ err: error }, 'redis error'));
  redis.on('ready', () => app.log.info('redis connected'));
  await redis.connect();
  app.addHook('onClose', async () => {
    await redis.quit();
  });
}
