import type { FastifyInstance } from 'fastify';
import { AppError } from '../shared/errors/app-error.js';

export function setupErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }
    request.log.error(error);
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({
      error: 'INTERNAL_ERROR',
      message: status >= 500 ? 'Something went wrong' : (error as Error).message,
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: 'NOT_FOUND', message: 'Route not found' });
  });
}
