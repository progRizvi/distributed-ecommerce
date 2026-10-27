import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { outbox } from '../db/schema/outbox.js';
import type { Tx } from '../db/transactor.js';
import type { BulkJob, FailedJobInfo, JobHandlers, JobName, JobPayloads, JobQueue } from './queue.js';

// OUTBOX PATTERN. Why: "save to database" and "put in Redis queue" are two systems, so one of them
// can fail after the other worked. Instead, the job is saved in the database in the SAME transaction
// as the business change. A relay then moves it to the queue, and the worker marks it sent when it ran.
// Redis can crash or be down: the job is still in the database and gets delivered later.
//
//   register -> [user row + outbox row, one transaction]
//   relay    -> reads pending rows -> BullMQ queue
//   worker   -> runs the job -> marks the row `sent`
//            -> or, if the job failed for good, marks the row `dead`
//
// DEAD LETTER QUEUE: a `dead` row is a job we gave up on (bad data, or all retries used). It stays in
// the table with its error. Look at it with `pnpm outbox:dead`, put it back with `pnpm outbox:replay`.
//
// Delivery is "at least once": in rare cases (worker dies after sending, before marking) a job runs twice.

export type NewOutboxEntry = {
  [K in JobName]: {
    name: K;
    payload: JobPayloads[K];
    /** Same key twice = one row. Use it so a retried action does not create two jobs. */
    dedupeKey?: string;
  };
}[JobName];

export type OutboxRow = {
  id: string;
  name: JobName;
  payload: Record<string, unknown>;
  /** How many times this row was given to the queue, including this time. */
  attempts: number;
  /** How many times the row was replayed from the dead letter queue. */
  replays: number;
};

// Used by services, inside their transaction.
export interface OutboxWriter {
  add(entry: NewOutboxEntry, tx?: Tx): Promise<void>;
}

export interface ClaimOptions {
  limit: number;
  /** A row given to the queue is not given again until this much time has passed. */
  leaseMs: number;
  /** Rows given to the queue this many times are left alone (a broken job must not loop forever). */
  maxAttempts: number;
}

// Used by the relay and the worker.
export interface OutboxRepository extends OutboxWriter {
  /** Takes pending rows for delivery. Safe with many relays at once: each row goes to one of them. */
  claim(options: ClaimOptions): Promise<OutboxRow[]>;
  /** Gives claimed rows back (the queue was not reachable), so the next pass picks them up at once. */
  release(ids: string[]): Promise<void>;
  /** True while the job still has to run (not `sent` yet). A `dead` row counts: a late delivery may still succeed. */
  isUnsent(id: string): Promise<boolean>;
  markSent(id: string): Promise<void>;
  /** The job failed for good. Only changes a `pending` row. The error is cleaned (no email addresses). */
  markDead(id: string, error: string): Promise<void>;
  /** Rows the queue lost again and again (too many deliveries, lease over) become `dead`. Returns how many. */
  sweepExhausted(options: Pick<ClaimOptions, 'leaseMs' | 'maxAttempts'>): Promise<number>;
}

// What a dead row looks like to a human. Never includes the payload (it holds email addresses).
export interface DeadRow {
  id: string;
  name: string;
  attempts: number;
  replays: number;
  lastError: string | null;
  failedAt: Date | null;
  createdAt: Date;
}

export type ReplayTarget = { id: string } | 'all';

// Used by the commands in scripts/outbox.ts.
export interface OutboxAdmin {
  listDead(limit: number): Promise<DeadRow[]>;
  /** How many dead rows replay() would put back (rows replayed `maxReplays` times already are skipped). */
  countReplayable(target: ReplayTarget, maxReplays: number): Promise<number>;
  /** Puts dead rows back to `pending` so the relay delivers them again. Returns how many. */
  replay(target: ReplayTarget, maxReplays: number): Promise<number>;
  countDeadOlderThan(days: number): Promise<number>;
  /** The only place that deletes outbox rows. Only `dead` rows, only old ones. */
  deleteDeadOlderThan(days: number): Promise<number>;
}

const MAX_ERROR_LENGTH = 500;

// Error messages (for example from the mail server) can repeat the address they refused.
// We keep the text for debugging, but not the address, and not too long.
export function sanitizeError(message: string): string {
  const clean = message.replace(/<?[^\s<>"',;()]+@[^\s<>"',;()]+>?/g, '<email>').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH)}...` : clean;
}

// Only this class talks to the outbox table.
export class DrizzleOutboxRepository implements OutboxRepository, OutboxAdmin {
  constructor(private readonly db: Database) {}

  async add(entry: NewOutboxEntry, tx?: Tx): Promise<void> {
    await (tx ?? this.db)
      .insert(outbox)
      .values({ name: entry.name, payload: { ...entry.payload }, dedupeKey: entry.dedupeKey ?? null })
      .onConflictDoNothing({ target: outbox.dedupeKey });
  }

  async claim({ limit, leaseMs, maxAttempts }: ClaimOptions): Promise<OutboxRow[]> {
    // One statement: pick rows (SKIP LOCKED = rows another relay is taking are skipped, not waited for)
    // and stamp them, so no long transaction is held while we talk to Redis.
    const result = await this.db.execute<OutboxRow>(sql`
      UPDATE outbox SET enqueued_at = now(), attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox
        WHERE status = 'pending'
          AND attempts < ${maxAttempts}
          AND (enqueued_at IS NULL OR enqueued_at < now() - make_interval(secs => ${leaseMs / 1000}))
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, name, payload, attempts, replays
    `);
    return result.rows;
  }

  async release(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(outbox)
      .set({ enqueuedAt: null, attempts: sql`greatest(${outbox.attempts} - 1, 0)` })
      .where(sql`${inArray(outbox.id, ids)} AND ${outbox.status} = 'pending'`);
  }

  async isUnsent(id: string): Promise<boolean> {
    const [row] = await this.db.select({ status: outbox.status }).from(outbox).where(eq(outbox.id, id)).limit(1);
    return row !== undefined && row.status !== 'sent';
  }

  async markSent(id: string): Promise<void> {
    await this.db
      .update(outbox)
      .set({ status: 'sent', sentAt: sql`now()` })
      .where(sql`${eq(outbox.id, id)} AND ${outbox.status} <> 'sent'`);
  }

  async markDead(id: string, error: string): Promise<void> {
    await this.db
      .update(outbox)
      .set({ status: 'dead', lastError: sanitizeError(error), failedAt: sql`now()` })
      .where(and(eq(outbox.id, id), eq(outbox.status, 'pending')));
  }

  async sweepExhausted({ leaseMs, maxAttempts }: Pick<ClaimOptions, 'leaseMs' | 'maxAttempts'>): Promise<number> {
    const rows = await this.db
      .update(outbox)
      .set({
        status: 'dead',
        failedAt: sql`now()`,
        lastError: `Gave up: the queue lost this job ${maxAttempts} times`,
      })
      .where(
        and(
          eq(outbox.status, 'pending'),
          sql`${outbox.attempts} >= ${maxAttempts}`,
          sql`${outbox.enqueuedAt} < now() - make_interval(secs => ${leaseMs / 1000})`,
        ),
      )
      .returning({ id: outbox.id });
    return rows.length;
  }

  async listDead(limit: number): Promise<DeadRow[]> {
    return this.db
      .select({
        id: outbox.id,
        name: outbox.name,
        attempts: outbox.attempts,
        replays: outbox.replays,
        lastError: outbox.lastError,
        failedAt: outbox.failedAt,
        createdAt: outbox.createdAt,
      })
      .from(outbox)
      .where(eq(outbox.status, 'dead'))
      .orderBy(desc(outbox.failedAt))
      .limit(limit);
  }

  async countReplayable(target: ReplayTarget, maxReplays: number): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(outbox).where(replayable(target, maxReplays));
    return row?.n ?? 0;
  }

  async replay(target: ReplayTarget, maxReplays: number): Promise<number> {
    const rows = await this.db
      .update(outbox)
      .set({ status: 'pending', attempts: 0, enqueuedAt: null, failedAt: null, replays: sql`${outbox.replays} + 1` })
      .where(replayable(target, maxReplays))
      .returning({ id: outbox.id });
    return rows.length;
  }

  async countDeadOlderThan(days: number): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(outbox).where(deadOlderThan(days));
    return row?.n ?? 0;
  }

  async deleteDeadOlderThan(days: number): Promise<number> {
    const rows = await this.db.delete(outbox).where(deadOlderThan(days)).returning({ id: outbox.id });
    return rows.length;
  }
}

function replayable(target: ReplayTarget, maxReplays: number) {
  return and(
    eq(outbox.status, 'dead'),
    lt(outbox.replays, maxReplays),
    target === 'all' ? undefined : eq(outbox.id, target.id),
  );
}

function deadOlderThan(days: number) {
  return and(eq(outbox.status, 'dead'), sql`${outbox.failedAt} < now() - make_interval(days => ${days})`);
}

export interface OutboxRelayOptions {
  batchSize?: number;
  /** Wait this long when there was nothing to do. */
  pollMs?: number;
  /**
   * Must be longer than the queue's own retry time (about 10 to 15 minutes), otherwise a job that is
   * still being retried would be given to the queue a second time.
   */
  leaseMs?: number;
  maxAttempts?: number;
  /** How often to look for rows the queue lost too many times. Not every pass: it is rarely needed. */
  sweepEveryMs?: number;
  onError?: (error: unknown) => void;
  onRelayed?: (count: number) => void;
  /** Called with the number of rows that became `dead` because the queue kept losing them. */
  onDead?: (count: number) => void;
}

// Moves pending outbox rows to the queue. Runs inside the worker process (see jobs/worker.ts).
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly onError: (error: unknown) => void;
  private readonly onRelayed: (count: number) => void;
  private readonly onDead: (count: number) => void;
  private readonly sweepEveryMs: number;
  private lastSweep = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly repo: OutboxRepository,
    private readonly queue: JobQueue,
    options: OutboxRelayOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.pollMs = options.pollMs ?? 2_000;
    this.leaseMs = options.leaseMs ?? 15 * 60 * 1000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.onError = options.onError ?? (() => {});
    this.onRelayed = options.onRelayed ?? (() => {});
    this.onDead = options.onDead ?? (() => {});
    this.sweepEveryMs = options.sweepEveryMs ?? 60_000;
  }

  /** One pass: claim a batch and hand it to the queue. Returns how many rows were claimed. */
  async tick(): Promise<number> {
    await this.sweep();
    const rows = await this.repo.claim({ limit: this.batchSize, leaseMs: this.leaseMs, maxAttempts: this.maxAttempts });
    if (rows.length === 0) return 0;
    try {
      await this.queue.enqueueBulk(rows.map(toBulkJob));
    } catch (error) {
      // Queue down: give the rows back so the next pass retries soon, not after the whole lease.
      await this.repo.release(rows.map((row) => row.id)).catch((releaseError: unknown) => this.onError(releaseError));
      throw error;
    }
    this.onRelayed(rows.length);
    return rows.length;
  }

  // Rows that were given to the queue too many times and never finished are given up on.
  private async sweep(): Promise<void> {
    if (Date.now() - this.lastSweep < this.sweepEveryMs) return;
    this.lastSweep = Date.now();
    try {
      const dead = await this.repo.sweepExhausted({ leaseMs: this.leaseMs, maxAttempts: this.maxAttempts });
      if (dead > 0) this.onDead(dead);
    } catch (error) {
      this.onError(error); // not fatal, delivery of other rows goes on
    }
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let claimed = 0;
      try {
        claimed = await this.tick();
      } catch (error) {
        this.onError(error);
      }
      // A full batch means there is probably more waiting: go again at once. Otherwise rest.
      if (!this.stopped && claimed < this.batchSize) await this.sleep(this.pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

function toBulkJob(row: OutboxRow): BulkJob {
  return {
    name: row.name,
    payload: { ...row.payload, outboxId: row.id },
    // A new id per delivery AND per replay: the queue never ignores a redelivery or a replay because the
    // old job (maybe in its failed list) is still stored. Duplicates are stopped by the `sent` check in
    // trackInOutbox instead.
    jobId: `${row.id}-${row.replays}-${row.attempts}`,
  } as BulkJob;
}

// Wraps the job handlers (worker side) so outbox jobs are marked `sent` after they ran.
// Jobs without outboxId (not from the outbox) pass through untouched.
export function trackInOutbox(handlers: JobHandlers, repo: Pick<OutboxRepository, 'isUnsent' | 'markSent'>): JobHandlers {
  const wrapped: Record<string, (payload: unknown) => Promise<void>> = {};
  for (const name of Object.keys(handlers) as JobName[]) {
    const handler = handlers[name] as (payload: unknown) => Promise<void>;
    wrapped[name] = async (payload) => {
      const { outboxId, ...data } = payload as { outboxId?: string } & Record<string, unknown>;
      if (outboxId === undefined) return handler(payload);
      // An earlier delivery of the same row already did the work: do not do it twice.
      if (!(await repo.isUnsent(outboxId))) return;
      await handler(data);
      await repo.markSent(outboxId);
    };
  }
  return wrapped as unknown as JobHandlers;
}

// For the worker's onFailed hook: when an outbox job failed for good (bad data, or all retries used),
// its row becomes `dead`. Never throws: if the database is down the row stays `pending`, and the relay
// gives up on it later if the queue keeps losing it.
export function deadLetterOnFailure(
  repo: Pick<OutboxRepository, 'markDead'>,
  log: (level: 'error' | 'warn', message: string, extra: Record<string, unknown>) => void,
): (job: FailedJobInfo, error: Error) => Promise<void> {
  return async (job, error) => {
    if (!job.final || !job.outboxId) return;
    try {
      await repo.markDead(job.outboxId, error.message);
      log('error', 'job moved to the dead letter queue', { outboxId: job.outboxId, name: job.name });
    } catch (markError) {
      log('warn', 'could not mark the job dead', { outboxId: job.outboxId, error: (markError as Error).message });
    }
  };
}
