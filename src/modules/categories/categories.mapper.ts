import type { Category, PublicCategory } from './categories.types.js';

export function toPublicCategory(category: Category): PublicCategory {
  return {
    id: category.id,
    parentId: category.parentId,
    name: category.name,
    slug: category.slug,
    description: category.description,
    status: category.status,
    position: category.position,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}
