import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { runOutboxCli } from '../../src/jobs/outbox-cli.js';
import { deadLetterOnFailure, DrizzleOutboxRepository, OutboxRelay, trackInOutbox } from '../../src/jobs/outbox.js';
import { FakeMailer, InMemoryQueue } from '../helpers/fakes.js';

// Real SQL on PGlite (in memory, no Docker, no real database touched). Rows deleted here only exist in this test.
const mail = { to: 'a@x.com', subject: 'Hi', text: 'Hello' };
const claimAll = { limit: 1000, leaseMs: 60_000, maxAttempts: 5 };
const MIGRATIONS = 'src/db/migrations';

describe('every migration applies on its own, like on a database that already has the earlier ones', () => {
  it('each file in its own transaction (a new enum value cannot be used in the migration that adds it)', async () => {
    const client = new PGlite();
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const statements = readFileSync(`${MIGRATIONS}/${file}`, 'utf8').split('--> statement-breakpoint');
      await client.exec('BEGIN');
      try {
        for (const statement of statements) await client.exec(statement);
        await client.exec('COMMIT');
      } catch (error) {
        await client.exec('ROLLBACK');
        throw new Error(`${file} does not apply: ${(error as Error).message}`, { cause: error });
      }
    }
    await client.close();
  });
});

describe('dead letter queue on real SQL', () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  const repo = new DrizzleOutboxRepository(db);
  let seq = 0;

  beforeAll(async () => {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS });
  });
  afterAll(async () => {
    await client.close();
  });

  async function newRow(payload: Record<string, unknown> = mail): Promise<string> {
    const key = `dlq-${(seq += 1)}`;
    await repo.add({ name: 'send-mail', payload: payload as typeof mail, dedupeKey: key });
    const [row] = await db.select({ id: schema.outbox.id }).from(schema.outbox).where(eq(schema.outbox.dedupeKey, key));
    return row!.id;
  }
  const rowOf = async (id: string) => (await db.select().from(schema.outbox).where(eq(schema.outbox.id, id)))[0]!;
  const ageDays = (id: string, days: number) =>
    db.update(schema.outbox).set({ failedAt: sql`now() - make_interval(days => ${days})` }).where(eq(schema.outbox.id, id));

  describe('markDead', () => {
    it('pending -> dead, with a clean error and a time', async () => {
      const id = await newRow();
      await repo.markDead(id, '550 5.1.1 <bob@example.com>: Recipient address rejected');
      const row = await rowOf(id);
      expect(row.status).toBe('dead');
      expect(row.lastError).toBe('550 5.1.1 <email>: Recipient address rejected');
      expect(row.failedAt).toBeInstanceOf(Date);
    });

    it('a dead row is not claimed any more', async () => {
      const id = await newRow();
      await repo.markDead(id, 'bad');
      const claimed = await repo.claim({ ...claimAll, leaseMs: 0 });
      expect(claimed.map((r) => r.id)).not.toContain(id);
    });

    it('never changes a sent row, and keeps the first error of a dead row', async () => {
      const sent = await newRow();
      await repo.markSent(sent);
      await repo.markDead(sent, 'late failure');
      expect((await rowOf(sent)).status).toBe('sent');

      const dead = await newRow();
      await repo.markDead(dead, 'first error');
      await repo.markDead(dead, 'second error');
      expect((await rowOf(dead)).lastError).toBe('first error');
    });

    it('a late successful delivery still wins: dead -> sent', async () => {
      const id = await newRow();
      await repo.markDead(id, 'gave up');
      expect(await repo.isUnsent(id)).toBe(true);
      await repo.markSent(id);
      const row = await rowOf(id);
      expect(row.status).toBe('sent');
      expect(row.sentAt).toBeInstanceOf(Date);
      expect(await repo.isUnsent(id)).toBe(false);
    });
  });

  describe('sweepExhausted', () => {
    it('gives up on rows that used all deliveries and whose lease is over; leaves the others', async () => {
      const exhausted = await newRow();
      const leased = await newRow();
      const fresh = await newRow();
      const past = sql`now() - interval '1 hour'`;
      await db.update(schema.outbox).set({ attempts: 5, enqueuedAt: past }).where(eq(schema.outbox.id, exhausted));
      await db.update(schema.outbox).set({ attempts: 5, enqueuedAt: sql`now()` }).where(eq(schema.outbox.id, leased));
      await db.update(schema.outbox).set({ attempts: 2, enqueuedAt: past }).where(eq(schema.outbox.id, fresh));

      const count = await repo.sweepExhausted({ leaseMs: 60_000, maxAttempts: 5 });

      expect(count).toBeGreaterThanOrEqual(1);
      expect((await rowOf(exhausted)).status).toBe('dead');
      expect((await rowOf(exhausted)).lastError).toContain('5 times');
      expect((await rowOf(leased)).status).toBe('pending');
      expect((await rowOf(fresh)).status).toBe('pending');
    });
  });

  describe('listDead', () => {
    it('shows only dead rows, newest first, and never the payload', async () => {
      const older = await newRow({ ...mail, to: 'secret-older@x.com' });
      const newer = await newRow({ ...mail, to: 'secret-newer@x.com' });
      await repo.markDead(older, 'e1');
      await repo.markDead(newer, 'e2');
      await ageDays(older, 2);
      const pending = await newRow();

      const rows = await repo.listDead(1000);
      const ids = rows.map((r) => r.id);
      expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
      expect(ids).not.toContain(pending);
      expect(JSON.stringify(rows)).not.toContain('secret-');
      expect(rows.every((r) => !('payload' in r))).toBe(true);
      expect((await repo.listDead(1)).length).toBe(1);
    });
  });

  describe('replay', () => {
    it('puts a dead row back: pending, fresh counters, replays + 1, error kept for history, claimable again', async () => {
      const id = await newRow();
      await db.update(schema.outbox).set({ attempts: 5, enqueuedAt: sql`now()` }).where(eq(schema.outbox.id, id));
      await repo.markDead(id, 'boom');

      expect(await repo.countReplayable({ id }, 3)).toBe(1);
      expect(await repo.replay({ id }, 3)).toBe(1);

      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'pending', attempts: 0, replays: 1, enqueuedAt: null, failedAt: null, lastError: 'boom' });
      const claimed = await repo.claim(claimAll);
      expect(claimed.find((r) => r.id === id)).toMatchObject({ attempts: 1, replays: 1 });
    });

    it('skips rows replayed maxReplays times already', async () => {
      const id = await newRow();
      await db.update(schema.outbox).set({ replays: 3 }).where(eq(schema.outbox.id, id));
      await repo.markDead(id, 'still broken');
      expect(await repo.countReplayable({ id }, 3)).toBe(0);
      expect(await repo.replay({ id }, 3)).toBe(0);
      expect((await rowOf(id)).status).toBe('dead');
    });

    it('"all" replays every dead row; pending and sent rows are never touched', async () => {
      const dead1 = await newRow();
      const dead2 = await newRow();
      const sent = await newRow();
      const pending = await newRow();
      await repo.markDead(dead1, 'x');
      await repo.markDead(dead2, 'x');
      await repo.markSent(sent);

      const before = await repo.countReplayable('all', 3);
      expect(before).toBeGreaterThanOrEqual(2);
      expect(await repo.replay('all', 3)).toBe(before);

      expect((await rowOf(dead1)).status).toBe('pending');
      expect((await rowOf(dead2)).status).toBe('pending');
      expect((await rowOf(sent)).status).toBe('sent');
      expect((await rowOf(pending)).replays).toBe(0);
    });
  });

  describe('deleteDeadOlderThan', () => {
    it('removes only dead rows older than the limit; everything else stays', async () => {
      const oldDead = await newRow();
      const freshDead = await newRow();
      const oldSent = await newRow();
      const oldPending = await newRow();
      await repo.markDead(oldDead, 'x');
      await repo.markDead(freshDead, 'x');
      await repo.markSent(oldSent);
      await ageDays(oldDead, 8);
      await db.update(schema.outbox).set({ createdAt: sql`now() - interval '30 days'` }).where(eq(schema.outbox.id, oldSent));
      await db.update(schema.outbox).set({ createdAt: sql`now() - interval '30 days'` }).where(eq(schema.outbox.id, oldPending));

      expect(await repo.countDeadOlderThan(7)).toBe(1);
      expect(await repo.deleteDeadOlderThan(7)).toBe(1);

      const exists = async (id: string) => (await db.select().from(schema.outbox).where(eq(schema.outbox.id, id))).length === 1;
      expect(await exists(oldDead)).toBe(false);
      expect(await exists(freshDead)).toBe(true);
      expect(await exists(oldSent)).toBe(true);
      expect(await exists(oldPending)).toBe(true);
      expect(await repo.countDeadOlderThan(7)).toBe(0);
    });
  });

  describe('the whole flow', () => {
    it('fails for good -> dead -> pnpm outbox:replay --yes -> delivered again (not ignored by the queue) -> sent', async () => {
      const queue = new InMemoryQueue();
      const mailer = new FakeMailer();
      const to = `flow-${(seq += 1)}@x.com`;
      const id = await newRow({ ...mail, to });
      const relay = new OutboxRelay(repo, queue, { sweepEveryMs: 60_000 });
      const handlers = trackInOutbox(createJobHandlers({ mailer }), repo);
      const markDead = deadLetterOnFailure(repo, () => {});
      const mine = () => queue.jobs.filter((j) => (j.payload as { to?: string }).to === to);
      const runMine = async () => {
        for (const job of mine()) await (handlers['send-mail'] as (p: unknown) => Promise<void>)(job.payload);
      };

      // 1. the mail server is down and every retry fails: the worker reports a final failure
      await relay.tick();
      mailer.failNext();
      const error = await runMine().then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error).toBeDefined();
      await markDead({ id: 'j', name: 'send-mail', attemptsMade: 8, maxAttempts: 8, final: true, outboxId: id }, error!);
      expect((await rowOf(id)).status).toBe('dead');

      // 2. a human looks at it: the list has the error but not the address
      const lines: string[] = [];
      await runOutboxCli(['dead'], repo, (l) => lines.push(l));
      expect(lines.join('\n')).toContain(id);
      expect(lines.join('\n')).not.toContain(to);

      // 3. dry run changes nothing, --yes puts it back
      await runOutboxCli(['replay', '--id', id], repo, () => {});
      expect((await rowOf(id)).status).toBe('dead');
      await runOutboxCli(['replay', '--id', id, '--yes'], repo, () => {});
      expect((await rowOf(id)).status).toBe('pending');

      // 4. the relay gives it to the queue again, with a NEW job id (the old one is still stored there)
      const idsBefore = mine().map((j) => j.options.jobId);
      await relay.tick();
      const idsAfter = mine().map((j) => j.options.jobId);
      expect(idsAfter).toHaveLength(idsBefore.length + 1);
      expect(new Set(idsAfter).size).toBe(idsAfter.length);

      // 5. the mail server is back: it is sent and the row is done
      const jobs = mine();
      await (handlers['send-mail'] as (p: unknown) => Promise<void>)(jobs[jobs.length - 1]!.payload);
      expect(mailer.sent.filter((m) => m.to === to)).toHaveLength(1);
      expect((await rowOf(id)).status).toBe('sent');
    });

    it('purge through the command: dry run keeps rows, --yes removes only old dead ones', async () => {
      const old = await newRow();
      await repo.markDead(old, 'x');
      await ageDays(old, 9);
      const lines: string[] = [];
      const out = (l: string) => lines.push(l);

      await runOutboxCli(['purge-dead'], repo, out);
      expect((await db.select().from(schema.outbox).where(eq(schema.outbox.id, old))).length).toBe(1);

      await runOutboxCli(['purge-dead', '--yes'], repo, out);
      expect((await db.select().from(schema.outbox).where(eq(schema.outbox.id, old))).length).toBe(0);
    });
  });
});
