import { eq } from 'drizzle-orm';
import categoryData from '../data/categories.json' with { type: 'json' };
import { db, type Database } from '../../client.js';
import { categories } from '../../schema/categories.js';
import type { SeedOptions } from '../index.js';

export interface SeedCategory {
  name: string;
  slug: string;
  description?: string;
  children?: SeedCategory[];
}

// Inserts a category tree. Safe to run many times: a slug that already exists is left as it is
// (nothing is changed or removed), and its children are still checked. Returns how many rows were created.
export async function insertCategoryTree(database: Database, nodes: SeedCategory[], parentId: string | null = null): Promise<number> {
  let created = 0;
  for (const [position, node] of nodes.entries()) {
    const [inserted] = await database
      .insert(categories)
      .values({ name: node.name, slug: node.slug, description: node.description ?? null, parentId, position })
      .onConflictDoNothing({ target: categories.slug })
      .returning({ id: categories.id });
    if (inserted) created += 1;

    const id = inserted?.id ?? (await database.select({ id: categories.id }).from(categories).where(eq(categories.slug, node.slug)))[0]?.id;
    if (id && node.children) created += await insertCategoryTree(database, node.children, id);
  }
  return created;
}

// Loads the tree from data/categories.json.
export async function seedCategories(_options: SeedOptions): Promise<void> {
  const created = await insertCategoryTree(db, categoryData as SeedCategory[]);
  console.log(created > 0 ? `  ${created} categories created` : '  categories already exist, left unchanged');
}
