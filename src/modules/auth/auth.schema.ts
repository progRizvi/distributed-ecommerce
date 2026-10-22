import { z } from 'zod';
import { publicUserSchema } from '../users/users.schema.js';

// bcrypt reads at most 72 bytes, so we refuse longer passwords (also protects against huge inputs).
const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long');

export const registerBodySchema = z.object({
  email: z.email().max(254),
  password: newPassword,
});

// Login does not re-check the password policy (old passwords must still work).
export const loginBodySchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});

// POST (not GET) so the email does not end up in URLs and access logs.
export const emailAvailableBodySchema = z.object({ email: z.email().max(254) });
export const emailAvailableResponseSchema = z.object({ available: z.boolean() });

export const authResponseSchema = z.object({
  user: publicUserSchema,
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  // Seconds until the access token expires.
  expiresIn: z.number().int(),
});

export const meResponseSchema = z.object({ user: publicUserSchema });

export const errorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string().optional() })).optional(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
