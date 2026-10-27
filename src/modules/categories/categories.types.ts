import type { categories } from '../../db/schema/categories.js';

export type CategoriesId = string;
export type Category = typeof categories.$inferSelect;
export type CategoryStatus = Category['status'];
export type NewCategory = Pick<typeof categories.$inferInsert, 'name' | 'slug' | 'description' | 'parentId' | 'position'>;
export type CategoryPatch = Partial<Pick<Category, 'name' | 'slug' | 'description' | 'parentId' | 'position' | 'status'>>;

// What the outside world sees (dates as text).
export interface PublicCategory {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  status: CategoryStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
}
