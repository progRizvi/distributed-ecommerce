import { z } from 'zod';

// The shape of every error response (see bootstrap/error-handler.ts). Used in route schemas.
export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string().optional() })).optional(),
});
