import { describe, expect, it } from 'vitest';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { OutboxRelay, trackInOutbox } from '../../src/jobs/outbox.js';
import { PermanentJobError } from '../../src/jobs/queue.js';
import { createFakeOutbox, FakeMailer, InMemoryQueue } from '../helpers/fakes.js';

const mail = { to: 'a@x.com', subject: 'Hi', text: 'Hello' };
const add = (outbox: ReturnType<typeof createFakeOutbox>, to = 'a@x.com') =>
  outbox.add({ name: 'send-mail', payload: { ...mail, to } });

describe('OutboxRelay', () => {
  it('moves pending rows to the queue in ONE bulk call, with the outbox id', async () => {
    const outbox = createFakeOutbox();
    const queue = new InMemoryQueue();
    await add(outbox, 'a@x.com');
    await add(outbox, 'b@x.com');

    const claimed = await new OutboxRelay(outbox, queue).tick();

    expect(claimed).toBe(2);
    expect(queue.bulkCalls).toBe(1);
    expect(queue.jobs).toHaveLength(2);
    for (const [i, job] of queue.jobs.entries()) {
      const row = outbox.rows[i]!;
      expect(job.payload).toMatchObject({ to: row.payload.to, outboxId: row.id });
      expect(job.options.jobId).toBe(`${row.id}-1`);
      expect(job.options.jobId).not.toContain(':');
    }
  });

  it('does nothing when there is nothing pending', async () => {
    const queue = new InMemoryQueue();
    expect(await new OutboxRelay(createFakeOutbox(), queue).tick()).toBe(0);
    expect(queue.bulkCalls).toBe(0);
  });

  it('queue down: gives the rows back, reports the error, and the next pass delivers them', async () => {
    const outbox = createFakeOutbox();
    const queue = new InMemoryQueue();
    await add(outbox);
    const relay = new OutboxRelay(outbox, queue);

    queue.failNext();
    await expect(relay.tick()).rejects.toThrow('queue down');
    expect(outbox.rows[0]).toMatchObject({ status: 'pending', attempts: 0, enqueuedAt: null });

    expect(await relay.tick()).toBe(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it('does not give a row again while its lease is running; redelivers after it ends', async () => {
    let now = 1_000;
    const outbox = createFakeOutbox(() => now);
    const queue = new InMemoryQueue();
    await add(outbox);
    const relay = new OutboxRelay(outbox, queue, { leaseMs: 60_000 });

    await relay.tick();
    now += 30_000;
    expect(await relay.tick()).toBe(0);
    now += 31_000; // Redis lost the job, nobody marked the row sent
    expect(await relay.tick()).toBe(1);
    expect(queue.jobs.map((j) => j.options.jobId)).toEqual([`${outbox.rows[0]!.id}-1`, `${outbox.rows[0]!.id}-2`]);
  });

  it('stops redelivering after maxAttempts', async () => {
    let now = 0;
    const outbox = createFakeOutbox(() => now);
    const queue = new InMemoryQueue();
    await add(outbox);
    const relay = new OutboxRelay(outbox, queue, { leaseMs: 10, maxAttempts: 3 });

    for (let i = 0; i < 6; i += 1) {
      now += 100;
      await relay.tick();
    }
    expect(queue.jobs).toHaveLength(3);
  });

  it('start/stop: delivers in the background and stops cleanly, even while waiting', async () => {
    const outbox = createFakeOutbox();
    const queue = new InMemoryQueue();
    await add(outbox);
    const relay = new OutboxRelay(outbox, queue, { pollMs: 60_000 });

    relay.start();
    relay.start(); // twice is harmless
    await new Promise((r) => setTimeout(r, 30));
    expect(queue.jobs).toHaveLength(1);

    const started = Date.now();
    await relay.stop(); // must not wait for the 60 s poll
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps going after an error', async () => {
    const outbox = createFakeOutbox();
    const queue = new InMemoryQueue();
    const errors: unknown[] = [];
    await add(outbox);
    queue.failNext();
    const relay = new OutboxRelay(outbox, queue, { pollMs: 10, onError: (e) => errors.push(e) });

    relay.start();
    await new Promise((r) => setTimeout(r, 100));
    await relay.stop();

    expect(errors).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });
});

describe('trackInOutbox', () => {
  async function deliver() {
    const outbox = createFakeOutbox();
    const queue = new InMemoryQueue();
    const mailer = new FakeMailer();
    await add(outbox);
    await new OutboxRelay(outbox, queue).tick();
    return { outbox, queue, mailer, handlers: trackInOutbox(createJobHandlers({ mailer }), outbox) };
  }

  it('sends the mail, then marks the row sent. The mailer never sees outboxId', async () => {
    const { outbox, queue, mailer, handlers } = await deliver();
    await queue.runAll(handlers);
    expect(mailer.sent).toEqual([mail]);
    expect(outbox.rows[0]?.status).toBe('sent');
  });

  it('a second job for an already sent row sends nothing (no double mail)', async () => {
    const { queue, mailer, handlers } = await deliver();
    await queue.runAll(handlers);
    await queue.runAll(handlers);
    expect(mailer.sent).toHaveLength(1);
  });

  it('if sending fails, the row stays pending so it is retried', async () => {
    const { outbox, queue, mailer, handlers } = await deliver();
    mailer.failNext();
    await expect(queue.runAll(handlers)).rejects.toThrow();
    expect(outbox.rows[0]?.status).toBe('pending');
    await queue.runAll(handlers); // retry works
    expect(outbox.rows[0]?.status).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
  });

  it('a permanent error stays a permanent error and the row stays pending', async () => {
    const outbox = createFakeOutbox();
    await outbox.add({ name: 'send-mail', payload: { ...mail, to: 'bad\nmail' } });
    const queue = new InMemoryQueue();
    await new OutboxRelay(outbox, queue).tick();
    const handlers = trackInOutbox(createJobHandlers({ mailer: new FakeMailer() }), outbox);
    await expect(queue.runAll(handlers)).rejects.toBeInstanceOf(PermanentJobError);
    expect(outbox.rows[0]?.status).toBe('pending');
  });

  it('jobs without outboxId run as before', async () => {
    const outbox = createFakeOutbox();
    const mailer = new FakeMailer();
    await trackInOutbox(createJobHandlers({ mailer }), outbox)['send-mail'](mail);
    expect(mailer.sent).toEqual([mail]);
  });
});
