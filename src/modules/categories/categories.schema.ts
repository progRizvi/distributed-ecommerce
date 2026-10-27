import { z } from 'zod';
import { SLUG_PATTERN } from '../../shared/utils/slug.js';

export const MAX_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_POSITION = 100_000;

const slugSchema = z.string().min(1).max(100).regex(SLUG_PATTERN, 'Use lowercase letters, digits and single dashes');
const nameSchema = z.string().trim().min(1, 'Name is required').max(MAX_NAME_LENGTH);
const descriptionSchema = z.string().trim().max(MAX_DESCRIPTION_LENGTH);
const positionSchema = z.number().int().min(0).max(MAX_POSITION);
const statusSchema = z.enum(['active', 'archived']);

export const categoryIdParamsSchema = z.object({ id: z.uuid() });
export const categorySlugParamsSchema = z.object({ slug: slugSchema });

// strictObject: unknown fields are rejected (not silently ignored), so a typo like "positon" is noticed.
export const createCategoryBodySchema = z.strictObject({
  name: nameSchema,
  // Made from the name when missing.
  slug: slugSchema.optional(),
  description: descriptionSchema.nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  position: positionSchema.optional(),
});

// Every field is optional (PATCH), but at least one must be sent. parentId: null moves it to the top level.
export const updateCategoryBodySchema = z
  .strictObject({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    parentId: z.uuid().nullable().optional(),
    position: positionSchema.optional(),
    status: statusSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one field to change');

export const listCategoriesQuerySchema = z.object({
  // Only admins may ask for anything but "active".
  status: z.enum(['active', 'archived', 'all']).default('active'),
  // A category id, or "root" for the top level. Missing = every level.
  parentId: z.union([z.uuid(), z.literal('root')]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Opaque text from the previous page's nextCursor.
  cursor: z.string().min(1).max(200).optional(),
});

export const publicCategorySchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  status: statusSchema,
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const categoryResponseSchema = z.object({ category: publicCategorySchema });
export const listCategoriesResponseSchema = z.object({
  items: z.array(publicCategorySchema),
  // Send it back as ?cursor= to get the next page. null = this was the last page.
  nextCursor: z.string().nullable(),
});

export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
