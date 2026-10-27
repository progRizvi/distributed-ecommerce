// The worker process. Run it next to the web server:
//   pnpm worker          (development, restarts on changes)
//   pnpm worker:start    (after pnpm build)
// It takes jobs from the queue and runs them. The web server only puts jobs in.
import { env } from '../bootstrap/env.js';
import { createMailer } from '../shared/mail/create-mailer.js';
import { BullMqWorker } from './bullmq-worker.js';
import { createJobHandlers } from './handlers.js';

type Level = 'info' | 'warn' | 'error';
const log = (level: Level, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'worker', msg, ...extra }));

const mailer = createMailer(
  { driver: env.MAIL_DRIVER, smtpUrl: env.SMTP_URL, from: env.MAIL_FROM },
  { log: (message) => log('info', message) },
);

const worker = new BullMqWorker(
  env.REDIS_URL,
  createJobHandlers({ mailer }),
  {
    onCompleted: (job) => log('info', 'job done', { job: job.id, name: job.name }),
    onFailed: (job, error) =>
      log(job.final ? 'error' : 'warn', job.final ? 'job failed for good' : 'job failed, will retry', {
        job: job.id,
        name: job.name,
        attempt: `${job.attemptsMade}/${job.maxAttempts}`,
        error: error.message,
      }),
    onError: (error) => log('error', 'worker error', { error: error.message }),
  },
  { concurrency: 5 },
);
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
    await worker.close();
    await mailer.close?.();
    process.exit(0);
  } catch (error) {
    log('error', 'shutdown failed', { error: (error as Error).message });
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
