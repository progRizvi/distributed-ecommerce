import Fastify, { type FastifyInstance } from 'fastify';
import { bootstrap } from './bootstrap/index.js';
import { loggerOptions } from './bootstrap/logger.js';
import { trustProxy } from './bootstrap/proxy.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions, trustProxy, genReqId: () => crypto.randomUUID() });
  await bootstrap(app);
  return app;
}
