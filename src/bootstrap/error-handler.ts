import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../shared/errors/app-error.js';

// Client only sees safe, generic messages. Details go to the log, never to the response.
export function setupErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Our own errors: we wrote the message, it is meant for the client.
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }

    // Request validation: tell which field is wrong, nothing about our schema internals.
    if (error.validation) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 500) {
      request.log.error(error);
    } else {
      request.log.warn({ err: error }, 'client error');
    }

    // Other 4xx (bad JSON, expired token, rate limit...): standard HTTP text only, not error.message.
    const message = STATUS_CODES[status] ?? 'Error';
    const code = status >= 500 ? 'INTERNAL_ERROR' : message.toUpperCase().replace(/[^A-Z]+/g, '_');
    return reply.status(status >= 400 ? status : 500).send({ error: code, message: status >= 500 ? 'Something went wrong' : message });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: 'NOT_FOUND', message: 'Route not found' });
  });
}
