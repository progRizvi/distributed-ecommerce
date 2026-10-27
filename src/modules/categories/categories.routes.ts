import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorResponseSchema } from '../../shared/http/error-schema.js';
import type { CategoriesController } from './categories.controller.js';
import {
  categoryIdParamsSchema,
  categoryResponseSchema,
  categorySlugParamsSchema,
  createCategoryBodySchema,
  listCategoriesQuerySchema,
  listCategoriesResponseSchema,
  updateCategoryBodySchema,
} from './categories.schema.js';

export function createCategoriesRoutes(controller: CategoriesController): FastifyPluginAsync {
  return async (instance) => {
    const app = instance.withTypeProvider<ZodTypeProvider>();
    const adminOnly = [instance.requireRole('admin')];

    // Public routes also work with a token: an admin then sees archived categories too.
    // No token = a visitor. A token that is wrong or revoked is still a 401 (never silently ignored).
    const optionalAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (req.headers.authorization !== undefined) await instance.authenticate(req, reply);
    };
    const isAdmin = (req: FastifyRequest): boolean => req.headers.authorization !== undefined && req.user.role === 'admin';

    app.get(
      '/',
      {
        onRequest: [optionalAuth],
        schema: {
          tags: ['categories'],
          summary: 'List categories (oldest position first, 50 per page)',
          description: 'Use parentId=root for the top level, or a category id for its children. Pages: send nextCursor back as cursor.',
          querystring: listCategoriesQuerySchema,
          security: [{}, { bearerAuth: [] }],
          response: { 200: listCategoriesResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 403: errorResponseSchema },
        },
      },
      (req) => controller.list(req.query, isAdmin(req)),
    );

    app.get(
      '/slug/:slug',
      {
        onRequest: [optionalAuth],
        schema: {
          tags: ['categories'],
          summary: 'One category by its URL slug',
          params: categorySlugParamsSchema,
          security: [{}, { bearerAuth: [] }],
          response: { 200: categoryResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
        },
      },
      (req) => controller.getBySlug(req.params.slug, isAdmin(req)),
    );

    app.get(
      '/:id',
      {
        onRequest: [optionalAuth],
        schema: {
          tags: ['categories'],
          summary: 'One category by id',
          params: categoryIdParamsSchema,
          security: [{}, { bearerAuth: [] }],
          response: { 200: categoryResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema },
        },
      },
      (req) => controller.getById(req.params.id, isAdmin(req)),
    );

    app.post(
      '/',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['categories'],
          summary: 'Create a category (admin)',
          body: createCategoryBodySchema,
          security: [{ bearerAuth: [] }],
          response: {
            201: categoryResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (req, reply) => reply.status(201).send(await controller.create(req.body)),
    );

    app.patch(
      '/:id',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['categories'],
          summary: 'Change a category (admin). Send only the fields to change; status "active" restores an archived one.',
          params: categoryIdParamsSchema,
          body: updateCategoryBodySchema,
          security: [{ bearerAuth: [] }],
          response: {
            200: categoryResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      (req) => controller.update(req.params.id, req.body),
    );

    app.delete(
      '/:id',
      {
        onRequest: adminOnly,
        schema: {
          tags: ['categories'],
          summary: 'Archive a category (admin). It is hidden, not removed, and can be restored with PATCH.',
          params: categoryIdParamsSchema,
          security: [{ bearerAuth: [] }],
          response: {
            204: z.null(),
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        await controller.archive(req.params.id);
        return reply.status(204).send(null);
      },
    );
  };
}
