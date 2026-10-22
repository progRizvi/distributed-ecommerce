import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { env } from './env.js';

export async function setupSwagger(app: FastifyInstance): Promise<void> {
  if (env.NODE_ENV === 'production') return;
  await app.register(swagger, {
    openapi: {
      info: { title: 'Ecommerce API', version: '0.1.0' },
      tags: [
        { name: 'system', description: 'Health and status' },
        { name: 'auth', description: 'Register, login, tokens' },
      ],
      components: {
        securitySchemes: {
          // Click "Authorize" in /docs and paste the accessToken from login.
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
}
