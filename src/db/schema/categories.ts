import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

// archived = hidden from the shop, kept in the database (categories are never deleted: products and orders may point to them).
export const categoryStatus = pgEnum('category_status', ['active', 'archived']);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // null = top level. Same table, so the database itself keeps parent ids valid.
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
    name: text('name').notNull(),
    // Used in URLs: lowercase letters, digits and single dashes.
    slug: text('slug').notNull(),
    description: text('description'),
    status: categoryStatus('status').notNull().default('active'),
    // Lower comes first among siblings.
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_unique').on(t.slug),
    // Listing the children of one category in order (also the keyset pagination order).
    index('categories_parent_position_idx').on(t.parentId, t.position, t.id),
  ],
);
