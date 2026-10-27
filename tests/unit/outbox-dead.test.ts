import { describe, expect, it } from 'vitest';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { deadLetterOnFailure, OutboxRelay, sanitizeError, trackInOutbox } from '../../src/jobs/outbox.js';
import type { FailedJobInfo } from '../../src/jobs/queue.js';
import { createFakeOutbox, FakeMailer, InMemoryQueue } from '../helpers/fakes.js';

const mail = { to: 'a@x.com', subject: 'Hi', text: 'Hello' };
const failed = (extra: Partial<FailedJobInfo> = {}): FailedJobInfo => ({
  id: 'job-1',
  name: 'send-mail',
  attemptsMade: 8,
  maxAttempts: 8,
  final: true,
  ...extra,
});

describe('sanitizeError', () => {
  it('removes email addresses, keeps the rest', () => {
    expect(sanitizeError('550 5.1.1 <bob@example.com>: Recipient address rejected')).toBe('550 5.1.1 <email>: Recipient address rejected');
    expect(sanitizeError('mailbox alice+tag@mail.example.org unavailable, tried bob@x.com')).toBe(
      'mailbox <email> unavailable, tried <email>',
    );
  });

  it('puts the text on one line and cuts it at 500 characters', () => {
    expect(sanitizeError('line one\nline   two')).toBe('line one line two');
    const long = sanitizeError('x'.repeat(2_000));
    expect(long.length).toBeLessThanOrEqual(503);
    expect(long.endsWith('...')).toBe(true);
  });
});

describe('deadLetterOnFailure (the worker hook)', () => {
  async function setup() {
    const outbox = createFakeOutbox();
    await outbox.add({ name: 'send-mail', payload: mail });
    const logs: { level: string; message: string }[] = [];
    const hook = deadLetterOnFailure(outbox, (level, message) => logs.push({ level, message }));
    return { outbox, hook, id: outbox.rows[0]!.id, logs };
  }

  it('final failure: the row becomes dead with a clean error, and it is logged', async () => {
    const { outbox, hook, id, logs } = await setup();
    await hook(failed({ outboxId: id }), new Error('550 <a@x.com> rejected'));
    expect(outbox.rows[0]).toMatchObject({ status: 'dead', lastError: '550 <email> rejected' });
    expect(outbox.rows[0]?.failedAt).not.toBeNull();
    expect(logs).toEqual([{ level: 'error', message: expect.stringContaining('dead letter') }]);
  });

  it('a failure that will be retried does not touch the row', async () => {
    const { outbox, hook, id } = await setup();
    await hook(failed({ outboxId: id, final: false, attemptsMade: 2 }), new Error('smtp down'));
    expect(outbox.rows[0]?.status).toBe('pending');
  });

  it('a job that did not come from the outbox is ignored', async () => {
    const { outbox, hook } = await setup();
    await hook(failed(), new Error('boom'));
    expect(outbox.rows[0]?.status).toBe('pending');
  });

  it('never throws, even if the database is down (the row stays pending)', async () => {
    const outbox = createFakeOutbox();
    const logs: string[] = [];
    const hook = deadLetterOnFailure(
      { markDead: () => Promise.reject(new Error('db down')) },
      (level, message) => logs.push(`${level}:${message}`),
    );
    await expect(hook(failed({ outboxId: 'x' }), new Error('boom'))).resolves.toBeUndefined();
    expect(logs).toEqual(['warn:could not mark the job dead']);
    expect(outbox.rows).toHaveLength(0);
  });

  it('end to end: a bad mail goes pending -> queue -> fails for good -> dead, and is never sent', async () => {
    const outbox = createFakeOutbox();
    await outbox.add({ name: 'send-mail', payload: { ...mail, to: 'bad\nmail' } });
    const queue = new InMemoryQueue();
    const mailer = new FakeMailer();
    await new OutboxRelay(outbox, queue).tick();

    const hook = deadLetterOnFailure(outbox, () => {});
    const handlers = trackInOutbox(createJobHandlers({ mailer }), outbox);
    const job = queue.jobs[0]!;
    const error = await (handlers['send-mail'](job.payload as never) as Promise<void>).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.name).toBe('PermanentJobError');
    await hook(failed({ outboxId: outbox.rows[0]!.id }), error!);

    expect(outbox.rows[0]?.status).toBe('dead');
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('a late delivery of a dead row', () => {
  it('still sends the mail and turns the row into sent', async () => {
    const outbox = createFakeOutbox();
    await outbox.add({ name: 'send-mail', payload: mail });
    const queue = new InMemoryQueue();
    const mailer = new FakeMailer();
    await new OutboxRelay(outbox, queue).tick();
    await outbox.markDead(outbox.rows[0]!.id, 'gave up');

    await queue.runAll(trackInOutbox(createJobHandlers({ mailer }), outbox));

    expect(mailer.sent).toHaveLength(1);
    expect(outbox.rows[0]?.status).toBe('sent');
  });

  it('markDead never changes a sent row', async () => {
    const outbox = createFakeOutbox();
    await outbox.add({ name: 'send-mail', payload: mail });
    await outbox.markSent(outbox.rows[0]!.id);
    await outbox.markDead(outbox.rows[0]!.id, 'late failure');
    expect(outbox.rows[0]?.status).toBe('sent');
  });
});

describe('relay gives up on jobs the queue keeps losing', () => {
  it('after maxAttempts deliveries and the lease: the row becomes dead and onDead is told', async () => {
    let now = 0;
    const outbox = createFakeOutbox(() => now);
    const queue = new InMemoryQueue();
    const dead: number[] = [];
    await outbox.add({ name: 'send-mail', payload: mail });
    const relay = new OutboxRelay(outbox, queue, { leaseMs: 100, maxAttempts: 2, sweepEveryMs: 0, onDead: (n) => dead.push(n) });

    now = 1_000;
    await relay.tick(); // delivery 1
    now = 2_000;
    await relay.tick(); // delivery 2
    expect(outbox.rows[0]?.status).toBe('pending'); // lease of delivery 2 is not over yet at this moment
    now = 3_000;
    await relay.tick(); // lease over, no more deliveries allowed -> dead

    expect(outbox.rows[0]).toMatchObject({ status: 'dead', lastError: expect.stringContaining('2 times') });
    expect(dead).toEqual([1]);
    expect(queue.jobs).toHaveLength(2);
  });

  it('the sweep does not run on every pass (only every sweepEveryMs)', async () => {
    const outbox = createFakeOutbox();
    let sweeps = 0;
    const counting = { ...outbox, sweepExhausted: async () => ((sweeps += 1), 0) };
    const relay = new OutboxRelay(counting, new InMemoryQueue(), { sweepEveryMs: 60_000 });
    await relay.tick();
    await relay.tick();
    await relay.tick();
    expect(sweeps).toBe(1);
  });

  it('a failing sweep is reported but does not stop delivery', async () => {
    const outbox = createFakeOutbox();
    await outbox.add({ name: 'send-mail', payload: mail });
    const queue = new InMemoryQueue();
    const errors: unknown[] = [];
    const broken = { ...outbox, sweepExhausted: () => Promise.reject(new Error('db hiccup')) };
    const relay = new OutboxRelay(broken, queue, { sweepEveryMs: 0, onError: (e) => errors.push(e) });

    expect(await relay.tick()).toBe(1);
    expect(errors).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
  });
});
