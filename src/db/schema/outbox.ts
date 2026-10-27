import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// pending = waiting or being delivered, sent = the job ran, dead = gave up (this table is the dead letter queue).
export const outboxStatus = pgEnum('outbox_status', ['pending', 'sent', 'dead']);

// Jobs that must not be lost. A row is written in the SAME transaction as the business change
// (for example the new user), so both exist or neither does. The worker process then moves
// pending rows to the queue and marks them `sent` once the job really ran.
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Job name, see JobPayloads in src/jobs/queue.ts.
    name: text('name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    // Same key twice = one row (for example `welcome-<userId>`).
    dedupeKey: text('dedupe_key').unique(),
    status: outboxStatus('status').notNull().default('pending'),
    // When the relay last gave the row to the queue. Redelivery waits for a lease after this time.
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    // How many times the relay gave the row to the queue (stops endless redelivery of a broken job).
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    // Dead letter fields. lastError never holds an email address (see sanitizeError in jobs/outbox.ts).
    lastError: text('last_error'),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    // How many times someone put the dead row back with `pnpm outbox:replay` (stops endless replay loops).
    replays: integer('replays').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The relay only looks at pending rows, so keep the index small.
    index('outbox_pending_idx').on(t.createdAt).where(sql`${t.status} = 'pending'`),
    // Dead rows are few: lets the list and purge scripts find them without scanning the table.
    // (Uses failed_at, not status = 'dead': Postgres cannot use a new enum value in the migration that adds it.)
    index('outbox_dead_idx').on(t.failedAt).where(sql`${t.failedAt} is not null`),
  ],
);
