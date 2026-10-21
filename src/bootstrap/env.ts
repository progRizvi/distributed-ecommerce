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
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV !== 'production') return;
    // Production must never run with example/placeholder values.
    for (const key of ['JWT_SECRET', 'DATABASE_URL'] as const) {
      if (PLACEHOLDER.test(cfg[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} looks like a placeholder value, set a real one` });
      }
    }
    if (new Set(cfg.JWT_SECRET).size < 10) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET is not random enough' });
    }
  });

export type Env = z.infer<typeof schema>;

// Fail fast: app does not start if config is invalid.
export const env: Env = schema.parse(process.env);
