import type { CreateCategoryBody, ListCategoriesQuery, UpdateCategoryBody } from './categories.schema.js';
import type { CategoriesService } from './categories.service.js';
import { toPublicCategory } from './categories.mapper.js';

// HTTP layer: turns service results into response bodies. No business rules here.
// Routes call these as controller.method(...) (never detached), so `this` is always correct.
export class CategoriesController {
  constructor(private readonly service: CategoriesService) {}

  async list(query: ListCategoriesQuery, isAdmin: boolean) {
    const page = await this.service.list(query, isAdmin);
    return { items: page.items.map(toPublicCategory), nextCursor: page.nextCursor };
  }

  async getById(id: string, isAdmin: boolean) {
    return { category: toPublicCategory(await this.service.getById(id, isAdmin)) };
  }

  async getBySlug(slug: string, isAdmin: boolean) {
    return { category: toPublicCategory(await this.service.getBySlug(slug, isAdmin)) };
  }

  async create(body: CreateCategoryBody) {
    return { category: toPublicCategory(await this.service.create(body)) };
  }

  async update(id: string, body: UpdateCategoryBody) {
    return { category: toPublicCategory(await this.service.update(id, body)) };
  }

  async archive(id: string): Promise<void> {
    await this.service.archive(id);
  }
}
