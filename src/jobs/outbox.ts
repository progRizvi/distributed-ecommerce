import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { outbox } from '../db/schema/outbox.js';
import type { Tx } from '../db/transactor.js';
import type { BulkJob, JobHandlers, JobName, JobPayloads, JobQueue } from './queue.js';

// OUTBOX PATTERN. Why: "save to database" and "put in Redis queue" are two systems, so one of them
// can fail after the other worked. Instead, the job is saved in the database in the SAME transaction
// as the business change. A relay then moves it to the queue, and the worker marks it sent when it ran.
// Redis can crash or be down: the job is still in the database and gets delivered later.
//
//   register -> [user row + outbox row, one transaction]
//   relay    -> reads pending rows -> BullMQ queue
//   worker   -> runs the job -> marks the row `sent`
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

export interface OutboxRow {
  id: string;
  name: JobName;
  payload: Record<string, unknown>;
  /** How many times this row was given to the queue, including this time. */
  attempts: number;
}

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
  isPending(id: string): Promise<boolean>;
  markSent(id: string): Promise<void>;
}

// Only this class talks to the outbox table.
export class DrizzleOutboxRepository implements OutboxRepository {
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
    const result = await this.db.execute<{ id: string; name: JobName; payload: Record<string, unknown>; attempts: number }>(sql`
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
      RETURNING id, name, payload, attempts
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

  async isPending(id: string): Promise<boolean> {
    const [row] = await this.db.select({ status: outbox.status }).from(outbox).where(eq(outbox.id, id)).limit(1);
    return row?.status === 'pending';
  }

  async markSent(id: string): Promise<void> {
    await this.db
      .update(outbox)
      .set({ status: 'sent', sentAt: sql`now()` })
      .where(sql`${eq(outbox.id, id)} AND ${outbox.status} = 'pending'`);
  }
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
  onError?: (error: unknown) => void;
  onRelayed?: (count: number) => void;
}

// Moves pending outbox rows to the queue. Runs inside the worker process (see jobs/worker.ts).
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly onError: (error: unknown) => void;
  private readonly onRelayed: (count: number) => void;
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
  }

  /** One pass: claim a batch and hand it to the queue. Returns how many rows were claimed. */
  async tick(): Promise<number> {
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
    // A new id per delivery: the queue never ignores a redelivery because the old job is still stored.
    // Duplicates are stopped by the `sent` check in trackInOutbox instead.
    jobId: `${row.id}-${row.attempts}`,
  } as BulkJob;
}

// Wraps the job handlers (worker side) so outbox jobs are marked `sent` after they ran.
// Jobs without outboxId (not from the outbox) pass through untouched.
export function trackInOutbox(handlers: JobHandlers, repo: Pick<OutboxRepository, 'isPending' | 'markSent'>): JobHandlers {
  const wrapped: Record<string, (payload: unknown) => Promise<void>> = {};
  for (const name of Object.keys(handlers) as JobName[]) {
    const handler = handlers[name] as (payload: unknown) => Promise<void>;
    wrapped[name] = async (payload) => {
      const { outboxId, ...data } = payload as { outboxId?: string } & Record<string, unknown>;
      if (outboxId === undefined) return handler(payload);
      // An earlier delivery of the same row already did the work: do not do it twice.
      if (!(await repo.isPending(outboxId))) return;
      await handler(data);
      await repo.markSent(outboxId);
    };
  }
  return wrapped as unknown as JobHandlers;
}
