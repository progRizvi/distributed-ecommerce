import { PGlite } from '@electric-sql/pglite';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';
import { DrizzleTransactor } from '../../src/db/transactor.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { DrizzleOutboxRepository, OutboxRelay, trackInOutbox } from '../../src/jobs/outbox.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TokenService } from '../../src/modules/auth/tokens.js';
import { DrizzleUsersRepository } from '../../src/modules/users/users.repository.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';
import { InMemoryEventBus } from '../../src/shared/events/event-bus.js';
import {
  createFakeAuthRepo,
  createFakeHasher,
  createFakeRevocations,
  createFakeThrottle,
  FakeMailer,
  InMemoryQueue,
} from '../helpers/fakes.js';

// Real SQL on PGlite (Postgres compiled to WebAssembly, in memory, no Docker, no real database touched).
// It runs our real migration files, so the outbox table and the claim query are tested for real.
// Not covered: two relays claiming at the same moment (PGlite has one connection).
const mail = { to: 'a@x.com', subject: 'Hi', text: 'Hello' };
const claimAll = { limit: 100, leaseMs: 60_000, maxAttempts: 5 };

describe('outbox on real SQL', () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  const outbox = new DrizzleOutboxRepository(db);
  const usersRepo = new DrizzleUsersRepository(db);
  const transactor = new DrizzleTransactor(db);
  let seq = 0;
  const email = () => `u${(seq += 1)}@x.com`;
  const pendingRows = async () => (await db.select().from(schema.outbox)).filter((r) => r.status === 'pending');

  beforeAll(async () => {
    await migrate(drizzle(client), { migrationsFolder: 'src/db/migrations' });
  });
  afterAll(async () => {
    await client.close();
  });

  it('the same dedupeKey twice makes one row', async () => {
    await outbox.add({ name: 'send-mail', payload: mail, dedupeKey: 'dup-1' });
    await outbox.add({ name: 'send-mail', payload: mail, dedupeKey: 'dup-1' });
    const rows = await db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, 'dup-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual(mail);
  });

  describe('atomic with the business change', () => {
    it('user and outbox row are saved together', async () => {
      const e = email();
      await transactor.run(async (tx) => {
        await usersRepo.create({ email: e, passwordHash: 'h', role: 'customer' }, tx);
        await outbox.add({ name: 'send-mail', payload: { ...mail, to: e }, dedupeKey: `t-${e}` }, tx);
      });
      expect(await usersRepo.findByEmail(e)).toBeDefined();
      expect(await db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `t-${e}`))).toHaveLength(1);
    });

    it('if the outbox write fails, the user is NOT saved', async () => {
      const e = email();
      await expect(
        transactor.run(async (tx) => {
          await usersRepo.create({ email: e, passwordHash: 'h', role: 'customer' }, tx);
          throw new Error('outbox write failed');
        }),
      ).rejects.toThrow('outbox write failed');
      expect(await usersRepo.findByEmail(e)).toBeUndefined();
    });

    it('if the user insert fails (duplicate email), no outbox row is left', async () => {
      const e = email();
      await usersRepo.create({ email: e, passwordHash: 'h', role: 'customer' });
      const before = (await db.select({ n: count() }).from(schema.outbox))[0]?.n;
      await expect(
        transactor.run(async (tx) => {
          await outbox.add({ name: 'send-mail', payload: mail, dedupeKey: `ghost-${e}` }, tx);
          await usersRepo.create({ email: e, passwordHash: 'h', role: 'customer' }, tx);
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      expect((await db.select({ n: count() }).from(schema.outbox))[0]?.n).toBe(before);
    });
  });

  describe('claim', () => {
    it('gives each pending row once, then leaves it alone until the lease ends', async () => {
      const key = `claim-${(seq += 1)}`;
      await outbox.add({ name: 'send-mail', payload: mail, dedupeKey: key });
      const first = await outbox.claim(claimAll);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((r) => r.attempts === 1 && r.name === 'send-mail')).toBe(true);

      expect(await outbox.claim(claimAll)).toEqual([]); // leased, nothing new to give

      const again = await outbox.claim({ ...claimAll, leaseMs: 0 }); // lease over -> redelivery
      expect(again.length).toBe(first.length);
      expect(again.every((r) => r.attempts === 2)).toBe(true);
    });

    it('stops after maxAttempts, so a broken job does not loop forever', async () => {
      await outbox.claim({ ...claimAll, leaseMs: 0, maxAttempts: 100 }); // drain others into a known state
      const row = await outbox.claim({ ...claimAll, leaseMs: 0, maxAttempts: 100 });
      const attempts = Math.max(...row.map((r) => r.attempts));
      expect(await outbox.claim({ ...claimAll, leaseMs: 0, maxAttempts: attempts })).toEqual([]);
    });

    it('release makes a row available again at once and undoes the attempt count', async () => {
      const claimed = await outbox.claim({ ...claimAll, leaseMs: 0, maxAttempts: 100 });
      const target = claimed[0];
      if (!target) throw new Error('expected a row');
      expect(await outbox.claim(claimAll)).toEqual([]);
      await outbox.release([target.id]);
      const next = await outbox.claim(claimAll);
      expect(next.map((r) => r.id)).toEqual([target.id]);
      expect(next[0]?.attempts).toBe(target.attempts);
    });

    it('respects the batch limit', async () => {
      for (let i = 0; i < 5; i += 1) await outbox.add({ name: 'send-mail', payload: mail, dedupeKey: `limit-${seq}-${i}` });
      expect((await outbox.claim({ ...claimAll, limit: 2, leaseMs: 0, maxAttempts: 1000 })).length).toBe(2);
    });
  });

  it('markSent: the row is no longer pending or claimable, and doing it twice is fine', async () => {
    await outbox.add({ name: 'send-mail', payload: mail, dedupeKey: `sent-${(seq += 1)}` });
    const [row] = (await pendingRows()).slice(-1);
    if (!row) throw new Error('expected a row');
    expect(await outbox.isPending(row.id)).toBe(true);
    await outbox.markSent(row.id);
    await outbox.markSent(row.id);
    expect(await outbox.isPending(row.id)).toBe(false);
    const claimed = await outbox.claim({ ...claimAll, leaseMs: 0, maxAttempts: 1000 });
    expect(claimed.map((r) => r.id)).not.toContain(row.id);
    const [stored] = await db.select().from(schema.outbox).where(eq(schema.outbox.id, row.id));
    expect(stored?.sentAt).toBeInstanceOf(Date);
  });

  it('end to end: register saves user + job, relay queues it, worker sends it and marks it sent', async () => {
    const mailer = new FakeMailer();
    const queue = new InMemoryQueue();
    const service = new AuthService({
      users: new UsersService({ repo: usersRepo }),
      repo: createFakeAuthRepo(),
      hasher: createFakeHasher(),
      tokens: new TokenService({ signAccess: (p) => p.sub, accessTtlSeconds: 900, refreshTtlSeconds: 3600 }),
      throttle: createFakeThrottle(),
      revocations: createFakeRevocations().revocations,
      events: new InMemoryEventBus(),
      transactor,
      outbox,
    });
    const e = email();
    const session = await service.register({ email: e, password: 'password123' }, { ip: '203.0.113.9' });

    // Redis/queue is down at first: the job is not lost, it just waits in the database.
    queue.failNext();
    const relay = new OutboxRelay(outbox, queue, { leaseMs: 60_000 });
    await expect(relay.tick()).rejects.toThrow('queue down');
    const stillThere = await db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `welcome-${session.user.id}`));
    expect(stillThere[0]?.status).toBe('pending');

    // Queue is back: the next pass delivers it (released rows are not stuck behind the lease).
    await relay.tick();
    const job = queue.jobs.find((j) => (j.payload as { to?: string }).to === e);
    expect(job?.payload).toMatchObject({ to: e, outboxId: stillThere[0]?.id });

    await queue.runAll(trackInOutbox(createJobHandlers({ mailer }), outbox));
    expect(mailer.sent.filter((m) => m.to === e)).toHaveLength(1);
    expect(await outbox.isPending(stillThere[0]?.id ?? '')).toBe(false);
  });
});
