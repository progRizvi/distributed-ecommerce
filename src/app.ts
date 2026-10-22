import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { bootstrap } from './bootstrap/index.js';
import { loggerOptions } from './bootstrap/logger.js';
import { trustProxy } from './bootstrap/proxy.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions, trustProxy, genReqId: () => crypto.randomUUID() });
  // Zod schemas on routes: validate requests, filter responses, and feed Swagger.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await bootstrap(app);
  return app;
}
