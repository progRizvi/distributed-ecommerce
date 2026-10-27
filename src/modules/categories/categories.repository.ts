import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { categories } from '../../db/schema/categories.js';
import { ConflictError } from '../../shared/errors/app-error.js';
import type { Category, CategoryPatch, CategoryStatus, NewCategory } from './categories.types.js';

export interface ListFilter {
  status: CategoryStatus | 'all';
  /** undefined = any parent, null = top level only, string = children of that category. */
  parentId?: string | null | undefined;
  limit: number;
  /** Keyset pagination: continue after this (position, id). */
  after?: { position: number; id: string } | undefined;
}

// The contract other code depends on. Tests use fakes of it.
export interface CategoriesRepository {
  findById(id: string): Promise<Category | undefined>;
  findBySlug(slug: string): Promise<Category | undefined>;
  list(filter: ListFilter): Promise<Category[]>;
  /** Throws ConflictError when the slug is taken. */
  create(input: NewCategory): Promise<Category>;
  /** Throws ConflictError when the slug is taken. Undefined if the id does not exist. */
  update(id: string, patch: CategoryPatch): Promise<Category | undefined>;
  hasActiveChildren(id: string): Promise<boolean>;
  /** Levels from the top down to this category (a top level category = 1). 0 if it does not exist. */
  depthOf(id: string): Promise<number>;
  /** Levels in the tree under this category, counting itself (no children = 1). 0 if it does not exist. */
  subtreeHeight(id: string): Promise<number>;
  /** True if `candidateId` is `rootId` or anywhere below it. */
  isInSubtree(rootId: string, candidateId: string): Promise<boolean>;
}

// Walking up or down never goes deeper than this, so bad data (a loop) cannot run forever.
const WALK_LIMIT = 25;

// Only this class talks to the categories table. Rows are archived (a status), never removed.
export class DrizzleCategoriesRepository implements CategoriesRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<Category | undefined> {
    const [row] = await this.db.select().from(categories).where(eq(categories.id, id)).limit(1);
    return row;
  }

  async findBySlug(slug: string): Promise<Category | undefined> {
    const [row] = await this.db.select().from(categories).where(eq(categories.slug, slug)).limit(1);
    return row;
  }

  async list({ status, parentId, limit, after }: ListFilter): Promise<Category[]> {
    return this.db
      .select()
      .from(categories)
      .where(
        and(
          status === 'all' ? undefined : eq(categories.status, status),
          parentId === undefined ? undefined : parentId === null ? sql`${categories.parentId} is null` : eq(categories.parentId, parentId),
          after ? sql`(${categories.position}, ${categories.id}) > (${after.position}, ${after.id})` : undefined,
        ),
      )
      .orderBy(asc(categories.position), asc(categories.id))
      .limit(limit);
  }

  async create(input: NewCategory): Promise<Category> {
    try {
      // No "is the slug free?" query first: two parallel requests would both pass it. The unique index decides.
      const [row] = await this.db.insert(categories).values(input).returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Slug is already used');
      throw error;
    }
  }

  async update(id: string, patch: CategoryPatch): Promise<Category | undefined> {
    try {
      const [row] = await this.db
        .update(categories)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(categories.id, id))
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Slug is already used');
      throw error;
    }
  }

  async hasActiveChildren(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.parentId, id), eq(categories.status, 'active')))
      .limit(1);
    return row !== undefined;
  }

  async depthOf(id: string): Promise<number> {
    const result = await this.db.execute<{ depth: number | null }>(sql`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, 1 AS depth FROM categories WHERE id = ${id}
        UNION ALL
        SELECT c.id, c.parent_id, up.depth + 1 FROM categories c JOIN up ON c.id = up.parent_id WHERE up.depth < ${WALK_LIMIT}
      )
      SELECT max(depth)::int AS depth FROM up
    `);
    return result.rows[0]?.depth ?? 0;
  }

  async subtreeHeight(id: string): Promise<number> {
    const result = await this.db.execute<{ height: number | null }>(sql`
      WITH RECURSIVE down AS (
        SELECT id, 1 AS depth FROM categories WHERE id = ${id}
        UNION ALL
        SELECT c.id, down.depth + 1 FROM categories c JOIN down ON c.parent_id = down.id WHERE down.depth < ${WALK_LIMIT}
      )
      SELECT max(depth)::int AS height FROM down
    `);
    return result.rows[0]?.height ?? 0;
  }

  async isInSubtree(rootId: string, candidateId: string): Promise<boolean> {
    const result = await this.db.execute<{ found: boolean }>(sql`
      WITH RECURSIVE down AS (
        SELECT id, 1 AS depth FROM categories WHERE id = ${rootId}
        UNION ALL
        SELECT c.id, down.depth + 1 FROM categories c JOIN down ON c.parent_id = down.id WHERE down.depth < ${WALK_LIMIT}
      )
      SELECT EXISTS (SELECT 1 FROM down WHERE id = ${candidateId}) AS found
    `);
    return result.rows[0]?.found === true;
  }
}
