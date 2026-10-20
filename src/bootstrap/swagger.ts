import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';

export async function setupSwagger(app: FastifyInstance): Promise<void> {
  if (env.NODE_ENV === 'production') return;
  await app.register(swagger, {
    openapi: { info: { title: 'Ecommerce API', version: '0.1.0' } },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
}
