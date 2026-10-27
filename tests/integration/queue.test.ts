import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { BullMqQueue } from '../../src/jobs/bullmq-queue.js';
import { BullMqWorker } from '../../src/jobs/bullmq-worker.js';
import { PermanentJobError, type FailedJobInfo, type JobHandlers } from '../../src/jobs/queue.js';

// Real BullMQ on a real Redis. Skipped unless TEST_REDIS_URL is set:
//   PowerShell:  $env:TEST_REDIS_URL="redis://localhost:6379"; pnpm test
// Every test uses its own random queue name, so it never touches other keys. It never removes anything:
// the small leftover keys (bull:it-<id>:*) expire by themselves (finished jobs after 1 hour).
const url = process.env.TEST_REDIS_URL;

const mail = { to: 'a@x.com', subject: 'Hello', text: 'Body' };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function waitFor(condition: () => boolean, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup(handler: (mail: unknown) => Promise<void>, options: { attempts?: number } = {}) {
  const queueName = `it-${randomUUID()}`;
  const failures: FailedJobInfo[] = [];
  const handlers = { 'send-mail': handler } as JobHandlers;
  const queue = new BullMqQueue(url!, { queueName, backoffMs: 40, ...(options.attempts ? { attempts: options.attempts } : {}) });
  const worker = new BullMqWorker(url!, handlers, { onFailed: (job) => failures.push(job) }, { queueName, concurrency: 2 });
  cleanups.push(() => worker.close());
  cleanups.push(() => queue.close());
  return { queue, failures };
}

describe.skipIf(!url)('BullMQ queue and worker on real Redis', () => {
  it('runs a job', async () => {
    const sent: unknown[] = [];
    const { queue } = setup(async (m) => {
      sent.push(m);
    });

    await queue.enqueue('send-mail', mail);

    await waitFor(() => sent.length === 1);
    expect(sent[0]).toEqual(mail);
  });

  it('retries a temporary failure with backoff until it works', async () => {
    let calls = 0;
    const sent: unknown[] = [];
    const { queue, failures } = setup(async (m) => {
      calls += 1;
      if (calls < 3) throw new Error('smtp down');
      sent.push(m);
    });

    await queue.enqueue('send-mail', mail);

    await waitFor(() => sent.length === 1);
    expect(calls).toBe(3);
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => !f.final)).toBe(true);
  });

  it('does not retry a PermanentJobError', async () => {
    let calls = 0;
    const { queue, failures } = setup(async () => {
      calls += 1;
      throw new PermanentJobError('bad mail');
    });

    await queue.enqueue('send-mail', mail);

    await waitFor(() => failures.length === 1);
    await new Promise((r) => setTimeout(r, 600)); // long enough for any retry (backoff is 40ms)
    expect(calls).toBe(1);
    expect(failures[0]?.final).toBe(true);
  });

  it('gives up after the maximum number of attempts', async () => {
    let calls = 0;
    const { queue, failures } = setup(
      async () => {
        calls += 1;
        throw new Error('still down');
      },
      { attempts: 3 },
    );

    await queue.enqueue('send-mail', mail);

    await waitFor(() => failures.some((f) => f.final));
    expect(calls).toBe(3);
    expect(failures.map((f) => f.final)).toEqual([false, false, true]);
  });

  it('the same jobId runs only once', async () => {
    let calls = 0;
    const { queue } = setup(async () => {
      calls += 1;
    });

    await queue.enqueue('send-mail', mail, { jobId: 'welcome-user-1' });
    await queue.enqueue('send-mail', mail, { jobId: 'welcome-user-1' });
    await queue.enqueue('send-mail', { ...mail, to: 'b@x.com' }, { jobId: 'welcome-user-2' });

    await waitFor(() => calls >= 2);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toBe(2);
  });
});
