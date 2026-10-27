import { describe, expect, it } from 'vitest';
import { createJobHandlers } from '../../src/jobs/handlers.js';
import { registerAuthListeners } from '../../src/modules/auth/auth.listeners.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TokenService } from '../../src/modules/auth/tokens.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { InMemoryEventBus } from '../../src/shared/events/event-bus.js';
import {
  createFakeAuthRepo,
  createFakeHasher,
  createFakeRevocations,
  createFakeThrottle,
  createFakeUsersRepo,
  FakeMailer,
  InMemoryQueue,
} from '../helpers/fakes.js';

function setup() {
  const errors: unknown[] = [];
  const events = new InMemoryEventBus((e) => errors.push(e));
  const queue = new InMemoryQueue();
  registerAuthListeners(events, queue);
  const service = new AuthService({
    users: new UsersService({ repo: createFakeUsersRepo() }),
    repo: createFakeAuthRepo(),
    hasher: createFakeHasher(),
    tokens: new TokenService({ signAccess: (p) => p.sub, accessTtlSeconds: 900, refreshTtlSeconds: 3600 }),
    throttle: createFakeThrottle(),
    revocations: createFakeRevocations().revocations,
    events,
  });
  return { service, queue, events, errors };
}

const ctx = { ip: '203.0.113.9' };
const tick = () => new Promise((r) => setImmediate(r));

describe('welcome mail goes through the queue', () => {
  it('registering puts ONE send-mail job in the queue, for the normalized email', async () => {
    const { service, queue } = setup();
    const session = await service.register({ email: '  Bob@X.COM ', password: 'password123' }, ctx);
    await tick();

    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]?.name).toBe('send-mail');
    expect(queue.jobs[0]?.payload).toMatchObject({ to: 'bob@x.com', subject: expect.stringMatching(/welcome/i) });
    expect(queue.jobs[0]?.options.jobId).toBe(`welcome-${session.user.id}`);
    expect(queue.jobs[0]?.options.jobId).not.toContain(':'); // BullMQ does not allow ":" in custom ids
  });

  it('the same event delivered twice still makes one job (idempotent jobId)', async () => {
    const { service, queue, events } = setup();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await tick();
    events.emit('user.registered', { userId: session.user.id, email: 'a@x.com' });
    await tick();
    expect(queue.jobs).toHaveLength(1);
  });

  it('a failed registration (duplicate email) queues nothing', async () => {
    const { service, queue } = setup();
    await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await tick();
    await service.register({ email: 'a@x.com', password: 'password123' }, ctx).catch(() => {});
    await tick();
    expect(queue.jobs).toHaveLength(1);
  });

  it('if the queue is down, registration still succeeds and the error is reported', async () => {
    const { service, queue, errors } = setup();
    queue.failNext();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await tick();
    expect(session.user.email).toBe('a@x.com');
    expect(queue.jobs).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('end to end: the worker side turns the queued job into a sent mail', async () => {
    const { service, queue } = setup();
    await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await tick();

    const mailer = new FakeMailer();
    await queue.runAll(createJobHandlers({ mailer }));

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('a@x.com');
  });
});
