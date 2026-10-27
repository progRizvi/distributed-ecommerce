// The worker process. Run it next to the web server:
//   pnpm worker          (development, restarts on changes)
//   pnpm worker:start    (after pnpm build)
// It does two things: the outbox relay moves saved jobs from the database to the queue,
// and the worker takes jobs from the queue and runs them. The web server only saves jobs (in the database).
import { env } from '../bootstrap/env.js';
import { db, pool } from '../db/client.js';
import { createMailer } from '../shared/mail/create-mailer.js';
import { BullMqQueue } from './bullmq-queue.js';
import { BullMqWorker } from './bullmq-worker.js';
import { createJobHandlers } from './handlers.js';
import { deadLetterOnFailure, DrizzleOutboxRepository, OutboxRelay, sanitizeError, trackInOutbox } from './outbox.js';

type Level = 'info' | 'warn' | 'error';
const log = (level: Level, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'worker', msg, ...extra }));

const mailer = createMailer(
  { driver: env.MAIL_DRIVER, smtpUrl: env.SMTP_URL, from: env.MAIL_FROM },
  { log: (message) => log('info', message) },
);

const outbox = new DrizzleOutboxRepository(db);
const deadLetter = deadLetterOnFailure(outbox, log);

const worker = new BullMqWorker(
  env.REDIS_URL,
  // trackInOutbox: after a job from the outbox ran, its row is marked `sent`.
  trackInOutbox(createJobHandlers({ mailer }), outbox),
  {
    onCompleted: (job) => log('info', 'job done', { job: job.id, name: job.name }),
    onFailed: (job, error) => {
      log(job.final ? 'error' : 'warn', job.final ? 'job failed for good' : 'job failed, will retry', {
        job: job.id,
        name: job.name,
        attempt: `${job.attemptsMade}/${job.maxAttempts}`,
        error: sanitizeError(error.message), // mail servers sometimes repeat the address in the error
      });
      // Failed for good: the outbox row becomes `dead` (our dead letter queue). See pnpm outbox:dead.
      void deadLetter(job, error);
    },
    onError: (error) => log('error', 'worker error', { error: error.message }),
  },
  { concurrency: 5 },
);

const queue = new BullMqQueue(env.REDIS_URL, { onError: (error) => log('warn', 'job queue error', { error: error.message }) });
const relay = new OutboxRelay(outbox, queue, {
  onRelayed: (count) => log('info', 'outbox rows given to the queue', { count }),
  onError: (error) => log('warn', 'outbox relay failed, will try again', { error: (error as Error).message }),
  onDead: (count) => log('error', 'jobs moved to the dead letter queue (the queue kept losing them)', { count }),
});
relay.start();
log('info', 'worker started');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down, finishing running jobs', { signal });
  // Do not wait forever for a stuck job.
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  try {
    await relay.stop();
    await worker.close();
    await queue.close();
    await mailer.close?.();
    await pool.end();
    process.exit(0);
  } catch (error) {
    log('error', 'shutdown failed', { error: (error as Error).message });
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
