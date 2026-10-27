import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors/app-error.js';
import { slugify } from '../../shared/utils/slug.js';
import type { CategoriesRepository } from './categories.repository.js';
import type { CreateCategoryBody, ListCategoriesQuery, UpdateCategoryBody } from './categories.schema.js';
import type { Category, CategoryPatch } from './categories.types.js';

/** A category can be this many levels deep (Electronics > Phones > Cases = 3). Keeps menus and queries small. */
export const MAX_DEPTH = 3;

// The cursor is just "position and id of the last item", hidden inside a text. The client treats it as opaque.
export function encodeCursor(category: Pick<Category, 'position' | 'id'>): string {
  return Buffer.from(JSON.stringify([category.position, category.id])).toString('base64url');
}

export function decodeCursor(cursor: string): { position: number; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && Number.isInteger(parsed[0]) && typeof parsed[1] === 'string' && /^[0-9a-f-]{36}$/i.test(parsed[1])) {
      return { position: parsed[0] as number, id: parsed[1] };
    }
  } catch {
    // falls through to the error below
  }
  throw new BadRequestError('Invalid cursor');
}

export interface CategoryPage {
  items: Category[];
  nextCursor: string | null;
}

// Business rules for categories. Routes and controller never touch the database.
// `isAdmin` comes from the caller's token: customers and visitors only see active categories.
export class CategoriesService {
  constructor(private readonly repo: CategoriesRepository) {}

  async list(query: ListCategoriesQuery, isAdmin: boolean): Promise<CategoryPage> {
    if (!isAdmin && query.status !== 'active') throw new ForbiddenError('Only admins can see archived categories');
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    // One extra row tells us if there is a next page, without a second count query.
    const rows = await this.repo.list({
      status: query.status,
      parentId: query.parentId === undefined ? undefined : query.parentId === 'root' ? null : query.parentId,
      limit: query.limit + 1,
      after,
    });
    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null };
  }

  async getById(id: string, isAdmin: boolean): Promise<Category> {
    return this.visible(await this.repo.findById(id), isAdmin);
  }

  async getBySlug(slug: string, isAdmin: boolean): Promise<Category> {
    return this.visible(await this.repo.findBySlug(slug), isAdmin);
  }

  async create(input: CreateCategoryBody): Promise<Category> {
    const slug = input.slug ?? slugify(input.name);
    if (!slug) throw new BadRequestError('A slug could not be made from this name, please send one');

    if (input.parentId) {
      const parent = await this.repo.findById(input.parentId);
      if (!parent || parent.status !== 'active') throw new BadRequestError('Parent category not found');
      if ((await this.repo.depthOf(parent.id)) + 1 > MAX_DEPTH) {
        throw new BadRequestError(`Categories can be at most ${MAX_DEPTH} levels deep`);
      }
    }

    // A taken slug becomes a ConflictError (409) from the unique index.
    return this.repo.create({
      name: input.name,
      slug,
      description: input.description?.trim() || null,
      parentId: input.parentId ?? null,
      position: input.position ?? 0,
    });
  }

  async update(id: string, input: UpdateCategoryBody): Promise<Category> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundError('Category not found');

    const changes: CategoryPatch = {};
    if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
    // The slug is part of public URLs, so it only changes when the admin sends a new one (never from a rename).
    if (input.slug !== undefined && input.slug !== current.slug) changes.slug = input.slug;
    if (input.description !== undefined) changes.description = input.description?.trim() || null;
    if (input.position !== undefined && input.position !== current.position) changes.position = input.position;

    const moving = input.parentId !== undefined && input.parentId !== current.parentId;
    if (moving) {
      await this.assertCanMoveUnder(current, input.parentId ?? null);
      changes.parentId = input.parentId ?? null;
    }

    if (input.status !== undefined && input.status !== current.status) {
      if (input.status === 'archived') {
        if (await this.repo.hasActiveChildren(id)) throw new ConflictError('Archive or move the subcategories first');
      } else if (!moving && current.parentId) {
        // Bringing a category back under an archived parent would hide it anyway.
        const parent = await this.repo.findById(current.parentId);
        if (!parent || parent.status !== 'active') throw new BadRequestError('The parent category is archived, restore it first');
      }
      changes.status = input.status;
    }

    if (Object.keys(changes).length === 0) return current;
    const updated = await this.repo.update(id, changes);
    if (!updated) throw new NotFoundError('Category not found');
    return updated;
  }

  /** "Delete" = archive. The row stays (products and old orders may point to it) and can be restored with update. */
  async archive(id: string): Promise<void> {
    await this.update(id, { status: 'archived' });
  }

  private visible(category: Category | undefined, isAdmin: boolean): Category {
    // Archived ones look like they do not exist for everyone but admins.
    if (!category || (category.status === 'archived' && !isAdmin)) throw new NotFoundError('Category not found');
    return category;
  }

  private async assertCanMoveUnder(category: Category, newParentId: string | null): Promise<void> {
    if (newParentId === null) return; // top level: always fits
    if (newParentId === category.id) throw new BadRequestError('A category cannot be its own parent');

    const parent = await this.repo.findById(newParentId);
    if (!parent || parent.status !== 'active') throw new BadRequestError('Parent category not found');
    if (await this.repo.isInSubtree(category.id, newParentId)) {
      throw new BadRequestError('A category cannot be moved under one of its own subcategories');
    }
    const [parentDepth, height] = await Promise.all([this.repo.depthOf(newParentId), this.repo.subtreeHeight(category.id)]);
    if (parentDepth + height > MAX_DEPTH) throw new BadRequestError(`Categories can be at most ${MAX_DEPTH} levels deep`);
  }
}
