import { z } from 'zod';

export const publicUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(['customer', 'admin']),
  createdAt: z.string(),
});
