import type { FastifyInstance } from 'fastify';
import { setupAuth } from './auth.js';
import { setupCache } from './cache.js';
import { setupCookie } from './cookie.js';
import { setupCors } from './cors.js';
import { setupDatabase } from './database.js';
import { setupErrorHandler } from './error-handler.js';
import { setupRateLimit } from './rate-limit.js';
import { setupRoutes } from './routes.js';
import { setupSecurity } from './security.js';
import { setupSwagger } from './swagger.js';

// Order matters. env + logger are loaded before this (see app.ts).
export async function bootstrap(app: FastifyInstance): Promise<void> {
  await setupDatabase(app);
  await setupCache(app);
  await setupSecurity(app);
  await setupCors(app);
  await setupRateLimit(app);
  await setupCookie(app);
  await setupAuth(app);
  await setupSwagger(app);
  setupErrorHandler(app);
  await setupRoutes(app);
}
