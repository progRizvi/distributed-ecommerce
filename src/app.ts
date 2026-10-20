import Fastify, { type FastifyInstance } from 'fastify';
import { bootstrap } from './bootstrap/index.js';
import { loggerOptions } from './bootstrap/logger.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions, genReqId: () => crypto.randomUUID() });
  await bootstrap(app);
  return app;
}
