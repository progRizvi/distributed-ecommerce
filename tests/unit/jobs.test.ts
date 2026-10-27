import { describe, expect, it } from 'vitest';
import { BullMqQueue } from '../../src/jobs/bullmq-queue.js';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { PermanentJobError } from '../../src/jobs/queue.js';
import { createRedisRetryStrategy } from '../../src/shared/redis/retry-strategy.js';
import { FakeMailer } from '../helpers/fakes.js';

const mail = { to: 'a@x.com', subject: 'Hello', text: 'Body' };

describe('send-mail job handler', () => {
  it('sends the mail through the Mailer', async () => {
    const mailer = new FakeMailer();
    await createJobHandlers({ mailer })['send-mail'](mail);
    expect(mailer.sent).toEqual([mail]);
  });

  it('an invalid mail is a PermanentJobError (no retries) and is never sent', async () => {
    const mailer = new FakeMailer();
    const handlers = createJobHandlers({ mailer });
    await expect(handlers['send-mail']({ ...mail, to: 'nope' })).rejects.toBeInstanceOf(PermanentJobError);
    await expect(handlers['send-mail']({ ...mail, subject: 'x\r\nBcc: y@x.com' })).rejects.toBeInstanceOf(PermanentJobError);
    expect(mailer.sent).toEqual([]);
  });

  it('a mail server problem is NOT permanent: the error goes up so the job is retried', async () => {
    const mailer = new FakeMailer();
    mailer.failNext();
    const error = await createJobHandlers({ mailer })['send-mail'](mail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentJobError);
  });
});

describe('createRedisRetryStrategy (backoff with jitter)', () => {
  it('grows exponentially and is capped', () => {
    const noJitter = createRedisRetryStrategy({ baseMs: 100, maxMs: 5_000, random: () => 1 }); // full delay
    expect([1, 2, 3, 4].map(noJitter)).toEqual([200, 400, 800, 1600]);
    expect(noJitter(50)).toBe(5_000);
  });

  it('adds jitter: the wait is between half and the full delay', () => {
    const low = createRedisRetryStrategy({ baseMs: 100, maxMs: 5_000, random: () => 0 });
    const high = createRedisRetryStrategy({ baseMs: 100, maxMs: 5_000, random: () => 0.999999 });
    expect(low(3)).toBe(400); // half of 800
    expect(high(3)).toBeGreaterThanOrEqual(799);
    expect(high(3)).toBeLessThanOrEqual(800);
  });

  it('two instances do not wait the same time (the whole point)', () => {
    const strategy = createRedisRetryStrategy();
    const waits = new Set(Array.from({ length: 20 }, () => strategy(5)));
    expect(waits.size).toBeGreaterThan(1);
  });
});

describe('BullMqQueue when Redis is not reachable', () => {
  it('enqueue rejects quickly instead of hanging forever', async () => {
    const queue = new BullMqQueue('redis://127.0.0.1:1', { enqueueTimeoutMs: 400 });
    const started = Date.now();
    await expect(queue.enqueue('send-mail', mail)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
    await queue.close();
  });
});
