import { z } from 'zod';

const PLACEHOLDER = /change-?me|changeit|secret|password|example|todo/i;

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    ELASTICSEARCH_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    COOKIE_SECRET: z.string().min(32),
    // Access token lifetime, like 900s, 15m, 1h. Keep it short.
    JWT_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/, 'use a number plus s, m, h or d (example: 15m)').default('15m'),
    // Which proxies we trust for the real client IP (X-Forwarded-For). Never "true" (anyone could fake an IP).
    // Default = private networks only (Nginx inside Docker). Use "false" if no proxy is in front.
    TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
  })
  .superRefine((cfg, ctx) => {
    // Each secret has one job: a leak of one must not break the other.
    if (cfg.COOKIE_SECRET === cfg.JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECRET'], message: 'COOKIE_SECRET must be different from JWT_SECRET' });
    }
    if (cfg.NODE_ENV !== 'production') return;
    // Production must never run with example/placeholder values.
    for (const key of ['JWT_SECRET', 'COOKIE_SECRET', 'DATABASE_URL'] as const) {
      if (PLACEHOLDER.test(cfg[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} looks like a placeholder value, set a real one` });
      }
    }
    for (const key of ['JWT_SECRET', 'COOKIE_SECRET'] as const) {
      if (new Set(cfg[key]).size < 10) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} is not random enough` });
      }
    }
  });

export type Env = z.infer<typeof schema>;

// Fail fast: app does not start if config is invalid.
export const env: Env = schema.parse(process.env);
