import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db/client.js';
import { CategoriesController } from './categories.controller.js';
import { DrizzleCategoriesRepository } from './categories.repository.js';
import { createCategoriesRoutes } from './categories.routes.js';
import { CategoriesService } from './categories.service.js';

export type { CategoriesId, Category, PublicCategory } from './categories.types.js';
export { CategoriesService } from './categories.service.js';

// Composition root: the only place that connects the real pieces together.
export const categoriesRoutes: FastifyPluginAsync = async (app) => {
  const service = new CategoriesService(new DrizzleCategoriesRepository(db));
  await app.register(createCategoriesRoutes(new CategoriesController(service)));
};
