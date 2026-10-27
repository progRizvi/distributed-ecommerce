import { randomUUID } from 'node:crypto';
import type { CategoriesRepository, ListFilter } from '../../src/modules/categories/categories.repository.js';
import type { Category, CategoryPatch, NewCategory } from '../../src/modules/categories/categories.types.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';

// In-memory categories table with the same rules as the real one (unique slug, ordering, tree walks).
export function createFakeCategoriesRepo(): CategoriesRepository & { rows: Category[] } {
  const rows: Category[] = [];
  const byId = (id: string) => rows.find((c) => c.id === id);
  const childrenOf = (id: string) => rows.filter((c) => c.parentId === id);

  function height(id: string): number {
    const kids = childrenOf(id);
    return 1 + (kids.length === 0 ? 0 : Math.max(...kids.map((k) => height(k.id))));
  }
  function subtree(id: string): string[] {
    return [id, ...childrenOf(id).flatMap((k) => subtree(k.id))];
  }

  return {
    rows,
    async findById(id) {
      return byId(id);
    },
    async findBySlug(slug) {
      return rows.find((c) => c.slug === slug);
    },
    async list({ status, parentId, limit, after }: ListFilter) {
      return rows
        .filter((c) => status === 'all' || c.status === status)
        .filter((c) => parentId === undefined || c.parentId === parentId)
        .filter((c) => !after || c.position > after.position || (c.position === after.position && c.id > after.id))
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async create(input: NewCategory) {
      if (rows.some((c) => c.slug === input.slug)) throw new ConflictError('Slug is already used');
      const category: Category = {
        id: randomUUID(),
        parentId: input.parentId ?? null,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        status: 'active',
        position: input.position ?? 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(category);
      return category;
    },
    async update(id, patch: CategoryPatch) {
      const category = byId(id);
      if (!category) return undefined;
      if (patch.slug !== undefined && rows.some((c) => c.slug === patch.slug && c.id !== id)) {
        throw new ConflictError('Slug is already used');
      }
      Object.assign(category, patch, { updatedAt: new Date() });
      return category;
    },
    async hasActiveChildren(id) {
      return childrenOf(id).some((c) => c.status === 'active');
    },
    async depthOf(id) {
      let depth = 0;
      for (let current = byId(id); current; current = current.parentId ? byId(current.parentId) : undefined) depth += 1;
      return depth;
    },
    async subtreeHeight(id) {
      return byId(id) ? height(id) : 0;
    },
    async isInSubtree(rootId, candidateId) {
      return byId(rootId) !== undefined && subtree(rootId).includes(candidateId);
    },
  };
}
