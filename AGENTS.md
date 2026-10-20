# Project Rules (all coding agents)

This file is the single source of truth for Claude Code, Codex, opencode, Cursor, and any agent that reads AGENTS.md.
Do not duplicate these rules elsewhere. `CLAUDE.md` only imports this file.

## Project
- Node.js distributed system. Check `package.json` for scripts before inventing commands.
- Stack: Node.js, Fastify, TypeScript 7, Oxlint, PostgreSQL, Redis, Elasticsearch, Nginx, Docker, Drizzle ORM.
- Package manager: **pnpm only**. Never use `npm` or `yarn`; never create `package-lock.json` or `yarn.lock`. Use `pnpm add`, `pnpm install`, `pnpm run`, `pnpm dlx`.

## Response style (user preference)
- Language: Banglish (Bangla written in English letters). Code, commands, file names stay in English.
- Format: bullet points, and tables when comparing or listing. No long paragraphs.
- Keep it short. Do not over-explain. Use easy, simple words.

## Workflow
1. Read the relevant code before changing it. Do not guess APIs, ports, or file layouts.
2. Make the smallest change that solves the task. No unrelated refactors or renames.
3. Run the project's tests/lint (see `package.json`) before saying a task is done. Report failures honestly.
4. Ask before anything destructive or outward-facing (deleting data, force-push, deploys, publishing).

## Code
- Match the style of surrounding code (naming, comments, module system).
- Async code: always handle rejections, set timeouts on network calls, make retries idempotent.
- Distributed concerns: no hidden shared state between services; design for partial failure, duplicate delivery, and out-of-order messages.
- No new dependency without a one-line justification in your reply.

## Network calls
- No unnecessary or recursive network calls (service A -> B -> A loops, calls inside loops, N+1 requests).
- Batch requests, cache results, and reuse data already fetched.
- Every retry needs a max limit and backoff. No unbounded retry or recursion.
- Add a depth/hop limit when services can call each other.
- Before adding a new network call, check if the data is already available.

## Security
- Never read, print, or commit `.env*`, private keys, or credentials. Use `.env.example` for shape.
- Never hardcode secrets, hosts, or ports; use config/env.

## Database
- Never delete database data (DELETE, DROP, TRUNCATE, deleteMany, flush, volume removal, migration reset/rollback) unless the user explicitly says so in this conversation.
- If a task seems to need deletion, stop and ask. Prefer additive migrations and soft deletes.
- Hooks enforce this for commands; the user lifts it by launching the agent with `ALLOW_DB_DELETE=1`.

## Git
- Agents never run `git add`, `git commit`, or `git push` (or equivalents: `git stash`, `git reset`, `git rebase`, `git merge`, `gh pr create`). The user runs these themselves.
- Read-only git (`status`, `diff`, `log`, `show`) is fine.
- When work is done, summarize the changes and suggest a commit message; do not commit.

## Hooks (enforced, not just advice)
Hooks live in `.agents/hooks/` and are wired per agent:
- Claude Code: `.claude/settings.json`
- Codex: `.codex/hooks.json`
- opencode: `.opencode/plugin/guard.js`
All call the same `.agents/hooks/core.mjs`. To change a policy, edit `core.mjs` once.
Run `node .agents/hooks/test.mjs` after editing.
