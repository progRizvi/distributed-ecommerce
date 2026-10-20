import type { FastifyServerOptions } from 'fastify';
import { env } from './env.js';

export const loggerOptions: FastifyServerOptions['logger'] = {
  level: env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie'],
};
