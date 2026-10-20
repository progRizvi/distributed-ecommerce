# Ecommerce (modular monolith)

Fastify + TypeScript 7 + Oxlint + Drizzle ORM + PostgreSQL + Redis + Elasticsearch + Nginx. Package manager: **pnpm only**.

## First-time setup

```bash
# 1. dependencies
pnpm add fastify @fastify/helmet @fastify/cors @fastify/rate-limit @fastify/cookie @fastify/jwt @fastify/swagger @fastify/swagger-ui drizzle-orm pg ioredis zod
pnpm add -D typescript@7 oxlint drizzle-kit tsx vitest @types/node @types/pg @faker-js/faker

# 2. config
cp .env.example .env                           # local run
cp docker/env/.env.dev.example docker/env/.env.dev   # docker run

# 3. start infra + app
pnpm docker:dev
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Run API with watch |
| `pnpm build` / `pnpm start` | Build and run production build |
| `pnpm lint` | Oxlint |
| `pnpm typecheck` | TypeScript check |
| `pnpm test` | Vitest |
| `pnpm db:generate` / `db:migrate` / `db:studio` | Drizzle migrations and GUI |
| `pnpm seed` | Insert test data (`--only=products`, `--count=100`) |
| `pnpm docker:dev` / `docker:prod` | Start the Docker stack |

## Structure

| Path | Purpose |
|---|---|
| `src/bootstrap/` | Everything loaded at boot (env, logger, db, cache, security, cors, auth, swagger, errors, routes, shutdown) |
| `src/modules/<name>/` | Feature code: routes, schema, types, controller, service, repository, test |
| `src/shared/` | Errors, utils, constants, global types |
| `src/db/` | Drizzle client, schema, migrations, seeds |
| `src/jobs/` | Background jobs |
| `docker/` | Compose files, Dockerfile, Postgres, Redis, Elasticsearch, Nginx configs |
| `logs/` | Runtime logs (gitignored) |
| `tests/` | Unit and e2e tests |

Rules for AI coding agents are in `AGENTS.md` (shared by Claude Code, Codex, opencode).
