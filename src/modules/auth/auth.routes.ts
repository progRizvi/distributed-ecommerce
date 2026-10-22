import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AuthController } from './auth.controller.js';
import {
  authResponseSchema,
  emailAvailableBodySchema,
  emailAvailableResponseSchema,
  errorResponseSchema,
  loginBodySchema,
  meResponseSchema,
  registerBodySchema,
} from './auth.schema.js';

// Stricter than the global limit: these endpoints are the ones attackers hit.
const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export function createAuthRoutes(controller: AuthController): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();

    app.post(
      '/register',
      {
        config: strictLimit,
        schema: {
          tags: ['auth'],
          summary: 'Create an account and log in',
          body: registerBodySchema,
          response: { 201: authResponseSchema, 400: errorResponseSchema, 409: errorResponseSchema, 429: errorResponseSchema },
        },
      },
      async (req, reply) => {
        const body = await controller.register(req.body, req, reply);
        return reply.status(201).send(body);
      },
    );

    app.post(
      '/login',
      {
        config: strictLimit,
        schema: {
          tags: ['auth'],
          summary: 'Log in with email and password',
          body: loginBodySchema,
          response: { 200: authResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 429: errorResponseSchema },
        },
      },
      (req, reply) => controller.login(req.body, req, reply),
    );

    app.post(
      '/email-available',
      {
        config: strictLimit,
        schema: {
          tags: ['auth'],
          summary: 'Is this email free? (a hint for the sign-up form, register still checks again)',
          body: emailAvailableBodySchema,
          response: { 200: emailAvailableResponseSchema, 400: errorResponseSchema, 429: errorResponseSchema },
        },
      },
      (req) => controller.emailAvailable(req.body.email),
    );

    app.post(
      '/refresh',
      {
        config: strictLimit,
        schema: {
          tags: ['auth'],
          summary: 'Get a new access token (uses the refresh cookie, which is rotated)',
          response: { 200: authResponseSchema, 401: errorResponseSchema, 429: errorResponseSchema },
        },
      },
      (req, reply) => controller.refresh(req, reply),
    );

    app.post(
      '/logout',
      {
        schema: {
          tags: ['auth'],
          summary: 'Log out this device',
          response: { 204: z.null() },
        },
      },
      async (req, reply) => {
        await controller.logout(req, reply);
        return reply.status(204).send(null);
      },
    );

    app.post(
      '/logout-all',
      {
        onRequest: [instance.authenticate],
        schema: {
          tags: ['auth'],
          summary: 'Log out every device',
          security: [{ bearerAuth: [] }],
          response: { 204: z.null(), 401: errorResponseSchema },
        },
      },
      async (req, reply) => {
        await controller.logoutAll(req.user.sub, reply);
        return reply.status(204).send(null);
      },
    );

    app.get(
      '/me',
      {
        onRequest: [instance.authenticate],
        schema: {
          tags: ['auth'],
          summary: 'Current user',
          security: [{ bearerAuth: [] }],
          response: { 200: meResponseSchema, 401: errorResponseSchema },
        },
      },
      (req) => controller.me(req.user.sub),
    );
  };
}
